const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const { Worker } = require('worker_threads');

// NEW: Import validators and cache systems
const FileValidator = require('./fileValidator');
const EnvelopeCache = require('./envelopeCache');
const HistoryManager = require('./historyManager');

// Swap the read-only asar path for the unpacked executable path
const ffmpegPath = ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked');
const ffprobePath = ffprobeInstaller.path.replace('app.asar', 'app.asar.unpacked');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const isMac = process.platform === 'darwin';

let mainWindow = null;

// NEW: Initialize cache and history manager
const envelopeCache = new EnvelopeCache();
const historyManager = new HistoryManager();

// ---------------------------------------------------------------------------
// Window + app lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  const windowOptions = {
    width: 1050,
    height: 750,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, // FIXED: Re-enabled sandbox for security
      preload: path.join(__dirname, 'preload.js')
    }
  };

  // Using hiddenInset to isolate system window controls safely from the web view headers
  if (isMac) {
    windowOptions.titleBarStyle = 'hiddenInset';
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Safe sender: never throws if the window was closed mid-processing
function sendToUI(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

app.whenReady().then(() => {
  createWindow();

  const menuTemplate = [
    { label: 'WaveSync', submenu: [{ role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

const tempDir = path.join(app.getPath('temp'), 'WaveSync_temp_audio');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// How many files to probe/extract/correlate at once
const EXTRACTION_CONCURRENCY = 4;
const EXTRACTION_TIMEOUT_MS = 3 * 60 * 1000;
const SYNC_ANALYSIS_WINDOW_SECONDS = 120;
const CHANNEL_ACTIVITY_WINDOW_SECONDS = 15;
const MINIMUM_FILE_DURATION = 1; // NEW: Minimum 1 second

// ---------------------------------------------------------------------------
// Concurrency + timeout helpers
// ---------------------------------------------------------------------------
async function processWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return results;
}

function withTimeout(promise, ms, label, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// Media helpers with validation and caching
// ---------------------------------------------------------------------------
function getMediaMetadata(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        resolve({ width: null, height: null, fps: 24, duration: 0, channels: 2, hasAudio: true });
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      const duration = metadata.format.duration ? parseFloat(metadata.format.duration) : 0;
      const channels = audioStream && audioStream.channels ? parseInt(audioStream.channels, 10) : 0;
      const hasAudio = !!audioStream && channels > 0;

      if (!videoStream) {
        resolve({ width: null, height: null, fps: 24, duration, channels, hasAudio });
        return;
      }

      let fps = 24;
      if (videoStream.r_frame_rate) {
        const parts = videoStream.r_frame_rate.split('/');
        const num = parseFloat(parts[0]);
        const den = parts.length === 2 ? parseFloat(parts[1]) : 1;
        if (num > 0 && den > 0) fps = num / den;
      }

      resolve({
        width: videoStream.width || null,
        height: videoStream.height || null,
        fps: parseFloat(fps.toFixed(3)),
        duration,
        channels,
        hasAudio
      });
    });
  });
}

function extractToWav(inputPath, outputPath, maxDurationSeconds, onProgress) {
  let command;
  const promise = new Promise((resolve, reject) => {
    command = ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .duration(maxDurationSeconds)
      .format('wav')
      .on('progress', (progress) => {
        if (onProgress && typeof progress.percent === 'number') {
          onProgress(Math.max(0, Math.min(99, Math.round(progress.percent))));
        }
      })
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
  return { promise, kill: () => command && command.kill('SIGKILL') };
}

function extractMultichannelSnippet(inputPath, outputPath, channelCount, maxDurationSeconds) {
  let command;
  const promise = new Promise((resolve, reject) => {
    command = ffmpeg(inputPath)
      .noVideo()
      .audioChannels(channelCount)
      .audioCodec('pcm_s16le')
      .duration(maxDurationSeconds)
      .format('wav')
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
  return { promise, kill: () => command && command.kill('SIGKILL') };
}

// ---------------------------------------------------------------------------
// Native File Browser Fallback Integration with Validation
// ---------------------------------------------------------------------------
ipcMain.on('trigger-file-browse', (event) => {
  dialog.showOpenDialog(mainWindow, {
    title: 'Select Media Files for WaveSync',
    buttonLabel: 'Import Media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Supported Media', extensions: ['mxf', 'mp4', 'mov', 'wav', 'mp3'] },
      { name: 'Broadcast Containers', extensions: ['mxf'] },
      { name: 'Video Files', extensions: ['mp4', 'mov'] },
      { name: 'Audio Envelopes', extensions: ['wav', 'mp3'] }
    ]
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      // NEW: Validate files before processing
      app.emit('handle-media-import', result.filePaths);
    }
  }).catch(err => {
    console.error('Native file open browser dialogue failed:', err);
  });
});

// IPC hook wrapper to pipe drag-and-drop array events safely
ipcMain.on('files-dropped', (event, absolutePaths) => {
  app.emit('handle-media-import', absolutePaths);
});

// NEW: IPC handlers for cache and history
ipcMain.on('get-cache-stats', (event) => {
  const stats = envelopeCache.getStats();
  event.reply('cache-stats-response', stats);
});

ipcMain.on('clear-cache', (event) => {
  const result = envelopeCache.clearAll();
  event.reply('cache-cleared', { success: result });
});

ipcMain.on('undo-timeline', (event) => {
  const undoAction = historyManager.undo();
  if (undoAction) {
    event.reply('timeline-undo-response', undoAction);
  }
});

ipcMain.on('redo-timeline', (event) => {
  const redoAction = historyManager.redo();
  if (redoAction) {
    event.reply('timeline-redo-response', redoAction);
  }
});

ipcMain.on('get-history', (event) => {
  const history = historyManager.getHistory();
  event.reply('history-response', history);
});

// ---------------------------------------------------------------------------
// Main Processing Orchestration Pipeline Loop with Validation
// ---------------------------------------------------------------------------
app.on('handle-media-import', async (absolutePaths) => {
  sendToUI('sync-calculating', 'Validating files and building processing queue...');
  
  let processedFiles = [];
  try {
    for (let p of absolutePaths) {
      // NEW: Validate file format first (MIME + magic bytes)
      const formatValidation = FileValidator.validateFileFormat(p);
      if (!formatValidation.isValid) {
        console.error(`Format validation failed for ${p}: ${formatValidation.error}`);
        sendToUI('extraction-error', { 
          file: path.basename(p), 
          error: formatValidation.error 
        });
        continue;
      }

      let meta = await getMediaMetadata(p);
      
      // NEW: Validate minimum duration (>= 1 second)
      const durationValidation = FileValidator.validateMinimumDuration(
        meta, 
        MINIMUM_FILE_DURATION
      );
      if (!durationValidation.isValid) {
        console.error(`Duration validation failed for ${p}: ${durationValidation.error}`);
        sendToUI('extraction-error', { 
          file: path.basename(p), 
          error: durationValidation.error 
        });
        continue;
      }

      let baseName = path.basename(p);
      let targetWav = path.join(tempDir, `${Date.now()}_${baseName}.wav`);
      
      // Extraction stage simulator representation mimicking pipeline updates
      sendToUI('extraction-progress', { file: baseName, percent: 50 });
      
      let extractObj = extractToWav(p, targetWav, SYNC_ANALYSIS_WINDOW_SECONDS);
      await extractObj.promise;
      
      sendToUI('file-ready', baseName);
      
      processedFiles.push({
        originalName: baseName,
        fullPath: p,
        wavPath: targetWav,
        meta: meta,
        activeChannels: Array.from({ length: meta.channels || 2 }, (_, i) => i + 1)
      });
    }
  } catch (exError) {
    console.error('File preprocessing pipeline tracking block failed:', exError);
    sendToUI('extraction-error', { file: 'Pre-Processor Stream', error: exError.message });
    return;
  }

  if (processedFiles.length === 0) return;

  (async () => {
    try {
      const referenceTrack = processedFiles[0];
      const syncReport = new Array(processedFiles.length);

      // Seed the base anchor timeline track configuration structure properties
      syncReport[0] = {
        file: referenceTrack.originalName,
        fullPath: referenceTrack.fullPath,
        offset: 0.0,
        status: 'Timeline Reference Base',
        meta: referenceTrack.meta,
        gainMultiplier: 1.0,
        wavPath: referenceTrack.wavPath,
        activeChannels: referenceTrack.activeChannels
      };

      const runSyncWorker = (refWav, targetWav) => {
        return new Promise((resolve, reject) => {
          const worker = new Worker(path.join(__dirname, 'syncWorker.js'), {
            workerData: { 
              referenceWavPath: refWav, 
              targetWavPath: targetWav,
              envelopeCachePath: envelopeCache.cacheDir // NEW: Pass cache dir to worker
            }
          });

          worker.on('message', (message) => {
            if (message.success) resolve(message.data);
            else reject(new Error(message.error));
          });

          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Sync worker stopped execution unexpectedly with exit status: ${code}`));
          });
        });
      };

      const targetTracksToProcess = processedFiles.slice(1);
      let runningTimelineEndCursor = referenceTrack.meta.duration || 0;

      // Run math cross-correlations concurrently utilizing processWithConcurrency across discrete threads
      await processWithConcurrency(
        targetTracksToProcess, 
        EXTRACTION_CONCURRENCY, 
        async (targetTrack, parallelIndex) => {
          const reportIndex = parallelIndex + 1;

          sendToUI(
            'sync-calculating', 
            `Correlating target tracking vector: ${targetTrack.originalName} (${reportIndex}/${processedFiles.length - 1})...`
          );

          const syncResult = await runSyncWorker(referenceTrack.wavPath, targetTrack.wavPath);

          let calculatedOffset;
          let displayStatus;

          if (syncResult.isFalseSyncMatch) {
            calculatedOffset = runningTimelineEndCursor;
            displayStatus = `Sequential Clip (Staggered Chronologically to +${calculatedOffset.toFixed(2)}s)`;
            runningTimelineEndCursor += targetTrack.meta.duration || 0;
          } else {
            calculatedOffset = Math.round(syncResult.offsetSeconds * 1000) / 1000;
            displayStatus = calculatedOffset >= 0
              ? `Delayed by +${calculatedOffset.toFixed(3)}s`
              : `Starts early by ${calculatedOffset.toFixed(3)}s`;

            const trackEnd = calculatedOffset + (targetTrack.meta.duration || 0);
            if (trackEnd > runningTimelineEndCursor) runningTimelineEndCursor = trackEnd;
          }

          syncReport[reportIndex] = {
            file: targetTrack.originalName,
            fullPath: targetTrack.fullPath,
            offset: calculatedOffset,
            status: displayStatus,
            meta: targetTrack.meta,
            peaks: syncResult.targetVisualPeaks,
            gainMultiplier: syncResult.targetGainMultiplier,
            wavPath: targetTrack.wavPath,
            activeChannels: targetTrack.activeChannels
          };

          // NEW: Record history action
          historyManager.push({
            type: 'SYNC_COMPLETE',
            payload: { trackName: targetTrack.originalName, offset: calculatedOffset },
            description: `Synced ${targetTrack.originalName}`,
          });
        }
      );

      sendToUI('sync-complete', syncReport);
    } catch (err) {
      console.error('Parallel math cross-correlation runtime crash:', err);
      sendToUI('extraction-error', { file: 'Analyzer Engine Cluster', error: err.message });
    }
  })();
});

// ---------------------------------------------------------------------------
// XML export
// ---------------------------------------------------------------------------
ipcMain.on('export-xml', (event, syncReport) => {
  const options = {
    title: 'Export Synchronized Timeline XML',
    defaultPath: path.join(app.getPath('desktop'), 'WaveSync_Timeline.xml'),
    buttonLabel: 'Export Timeline',
    filters: [{ name: 'XML Files', extensions: ['xml'] }]
  };

  dialog.showSaveDialog(mainWindow, options).then(file => {
    if (!file.canceled && file.filePath) {
      try {
        const xmlContent = generateFCP7XML(syncReport);
        fs.writeFileSync(file.filePath, xmlContent, 'utf-8');
        sendToUI('export-success', path.basename(file.filePath));
        
        // NEW: Record history
        historyManager.push({
          type: 'EXPORT_XML',
          payload: { filePath: file.filePath },
          description: `Exported XML to ${path.basename(file.filePath)}`,
        });
      } catch (err) {
        console.error('XML export failed:', err);
        sendToUI('extraction-error', { file: 'Exporter', error: 'Failed to write XML layout.' });
      }
    }
  });
});

function escapeXML(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toFileUrl(fullPath) {
  let systemPath = fullPath.replace(/\\/g, '/');
  if (!systemPath.startsWith('/')) systemPath = '/' + systemPath;
  const encoded = encodeURI(systemPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
  return `file://localhost${encoded}`;
}

function linkXml(links) {
  return links.map(l => `          <link>
            <linkclipref>${l.ref}</linkclipref>
            <mediatype>${l.mediatype}</mediatype>
            <trackindex>${l.trackindex}</trackindex>
            <clipindex>1</clipindex>
          </link>`).join('\n');
}

function generateFCP7XML(tracks) {
  let highestVideoTrack = null;
  let maxPixelArea = 0;

  tracks.forEach(track => {
    if (!track) return;
    const isWav = track.file && track.file.toLowerCase().endsWith('.wav');
    if (!isWav && track.meta && track.meta.width && track.meta.height) {
      const area = track.meta.width * track.meta.height;
      if (area > maxPixelArea) {
        maxPixelArea = area;
        highestVideoTrack = track;
      }
    }
  });

  const baseMeta = highestVideoTrack ? highestVideoTrack.meta : (tracks[0]?.meta || {});
  const globalWidth = baseMeta.width || 1920;
  const globalHeight = baseMeta.height || 1080;
  const globalFps = baseMeta.fps || 24;

  const timebaseVal = Math.round(globalFps);
  const isNTSCBool = Math.abs(globalFps - timebaseVal) > 0.001;
  const isNTSC = isNTSCBool ? 'TRUE' : 'FALSE';
  const exactFps = isNTSCBool ? (timebaseVal * 1000) / 1001 : timebaseVal;

  const nleColorLabels = ['Cyan', 'Red', 'Blue', 'Green', 'Purple', 'Orange'];
  const minOffset = tracks.reduce((min, t) => t ? Math.min(min, t.offset || 0) : min, 0);
  const shiftSeconds = minOffset < 0 ? -minOffset : 0;

  let videoTrackCounter = 0;
  let audioTrackCounter = 0;
  let sequenceEndFrame = 0;

  const clips = tracks.map((track, index) => {
    if (!track) return null;
    const meta = track.meta || {};
    const safeFileName = escapeXML(track.file || path.basename(track.fullPath));
    const safePathUrl = escapeXML(toFileUrl(track.fullPath));

    const startFrame = Math.max(0, Math.round(((track.offset || 0) + shiftSeconds) * exactFps));
    const durationFrames = Math.max(1, Math.round((meta.duration || 0) * exactFps));
    const endFrame = startFrame + durationFrames;
    if (endFrame > sequenceEndFrame) sequenceEndFrame = endFrame;

    const hasVideo = !!(meta.width && meta.height) && !safeFileName.toLowerCase().endsWith('.wav');
    const channelCount = meta.hasAudio === false ? 0 : (meta.channels || 2);

    const clip = {
      index,
      safeFileName,
      safePathUrl,
      startFrame,
      endFrame,
      durationFrames,
      labelColor: nleColorLabels[index % nleColorLabels.length],
      hasVideo,
      channelCount,
      width: meta.width,
      height: meta.height,
      fileId: hasVideo ? `file-media-video-${index}` : `file-media-audio-only-${index}`,
      video: null,
      audio: []
    };

    if (hasVideo) {
      videoTrackCounter++;
      clip.video = { id: `video-clip-${index}`, trackIndex: videoTrackCounter };
    }

    const channelsToInclude = (track.activeChannels && track.activeChannels.length > 0)
      ? track.activeChannels
      : Array.from({ length: channelCount }, (_, k) => k + 1);

    channelsToInclude.forEach((ch) => {
      audioTrackCounter++;
      clip.audio.push({ id: `audio-clip-${index}-ch${ch}`, trackIndex: audioTrackCounter, ch });
    });
    return clip;
  }).filter(Boolean);

  const definedFiles = new Set();

  function fileXml(clip, includeVideo) {
    if (definedFiles.has(clip.fileId)) return `<file id="${clip.fileId}"/>`;
    definedFiles.add(clip.fileId);

    const videoMedia = includeVideo ? `
              <video>
                <samplecharacteristics>
                  <width>${clip.width}</width>
                  <height>${clip.height}</height>
                </samplecharacteristics>
              </video>` : '';
    const audioMedia = clip.channelCount > 0 ? `
              <audio>
                <samplecharacteristics>
                  <depth>16</depth>
                  <samplerate>48000</samplerate>
                </samplecharacteristics>
                <channelcount>${clip.channelCount}</channelcount>
              </audio>` : '';

    return `<file id="${clip.fileId}">
            <name>${clip.safeFileName}</name>
            <pathurl>${clip.safePathUrl}</pathurl>
            <rate><timebase>${timebaseVal}</timebase><ntsc>${isNTSC}</ntsc></rate>
            <duration>${clip.durationFrames}</duration>
            <media>${videoMedia}${audioMedia}
            </media>
          </file>`;
  }

  let videoTracksXml = '';
  let audioTracksXml = '';

  clips.forEach(clip => {
    if (!clip.hasVideo) return;

    const links = [{ ref: clip.video.id, mediatype: 'video', trackindex: clip.video.trackIndex }]
      .concat(clip.audio.map(a => ({ ref: a.id, mediatype: 'audio', trackindex: a.trackIndex })));

    videoTracksXml += `      <track>
        <clipitem id="${clip.video.id}">
          <name>${clip.safeFileName}</name>
          <duration>${clip.durationFrames}</duration>
          <rate><timebase>${timebaseVal}</timebase><ntsc>${isNTSC}</ntsc></rate>
          <in>0</in><out>${clip.durationFrames}</out>
          <start>${clip.startFrame}</start><end>${clip.endFrame}</end>
          <labels><label2>${clip.labelColor}</label2></labels>
          ${fileXml(clip, true)}
${linkXml(links)}
          <logginginfo><description>WaveSync Alignment Pass</description></logginginfo>
        </clipitem>
        <enabled>TRUE</enabled>
      </track>\n`;
  });

  clips.forEach(clip => {
    const links = (clip.video
      ? [{ ref: clip.video.id, mediatype: 'video', trackindex: clip.video.trackIndex }]
      : []
    ).concat(clip.audio.map(a => ({ ref: a.id, mediatype: 'audio', trackindex: a.trackIndex })));

    clip.audio.forEach(a => {
      audioTracksXml += `      <track>
        <clipitem id="${a.id}">
          <name>${clip.safeFileName}</name>
          <duration>${clip.durationFrames}</duration>
          <rate><timebase>${timebaseVal}</timebase><ntsc>${isNTSC}</ntsc></rate>
          <in>0</in><out>${clip.durationFrames}</out>
          <start>${clip.startFrame}</start><end>${clip.endFrame}</end>
          <labels><label2>${clip.labelColor}</label2></labels>
          ${fileXml(clip, false)}
          <sourcetrack>
            <mediatype>audio</mediatype>
            <trackindex>${a.ch}</trackindex>
          </sourcetrack>
${linkXml(links)}
        </clipitem>
        <enabled>TRUE</enabled>
      </track>\n`;
    });
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-wavesync-master">
    <name>WaveSync Aligned Sequence</name>
    <uuid>com.wavesync.sequence.\${Date.now()}</uuid>
    <duration>${sequenceEndFrame}</duration>
    <rate>
      <timebase>${timebaseVal}</timebase>
      <ntsc>${isNTSC}</ntsc>
    </rate>
    <timecode>
      <rate>
        <timebase>${timebaseVal}</timebase>
        <ntsc>${isNTSC}</ntsc>
      </rate>
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>${globalWidth}</width>
            <height>${globalHeight}</height>
            <pixelaspectratio>square</pixelaspectratio>
            <rate>
              <timebase>${timebaseVal}</timebase>
              <ntsc>${isNTSC}</ntsc>
            </rate>
          </samplecharacteristics>
        </format>
\${videoTracksXml}      </video>
      <audio>
        <numOutputChannels>${audioTrackCounter}</numOutputChannels>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>48000</samplerate>
          </samplecharacteristics>
        </format>
\${audioTracksXml}      </audio>
    </media>
  </sequence>
</xmeml>`;
}

app.on('will-quit', () => {
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});
