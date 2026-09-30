/**
 * File Validation Module (fileValidator.js)
 * Handles MIME type detection, magic bytes validation, and file duration checks
 */

const fs = require('fs');
const path = require('path');

// Supported MIME types with their extensions
const SUPPORTED_MIME_TYPES = {
  // Video formats
  'video/mp4': ['.mp4'],
  'video/quicktime': ['.mov'],
  'video/x-mxf': ['.mxf'],
  
  // Audio formats
  'audio/wav': ['.wav'],
  'audio/mpeg': ['.mp3'],
  'audio/aac': ['.aac', '.m4a'],
};

// File extension to MIME type mapping
const EXTENSION_TO_MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mxf': 'video/x-mxf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.m4a': 'audio/aac',
};

/**
 * Validates file format by checking extension and file signature (magic bytes)
 * @param {string} filePath - Path to the file
 * @returns {object} { isValid: boolean, mimeType: string, error: string }
 */
function validateFileFormat(filePath) {
  if (!fs.existsSync(filePath)) {
    return { isValid: false, error: `File not found: ${filePath}` };
  }

  const ext = path.extname(filePath).toLowerCase();
  
  if (!EXTENSION_TO_MIME[ext]) {
    return { 
      isValid: false, 
      error: `Unsupported file format: ${ext}. Supported: .mp4, .mov, .mxf, .wav, .mp3, .aac` 
    };
  }

  // Validate file signature (magic bytes)
  const magicBytesResult = validateMagicBytes(filePath, ext);
  if (!magicBytesResult.isValid) {
    return magicBytesResult;
  }

  const mimeType = EXTENSION_TO_MIME[ext];
  return { isValid: true, mimeType, error: null };
}

/**
 * Validates file by checking magic bytes (file signature)
 * This prevents spoofed files (e.g., .txt renamed to .mp4)
 */
function validateMagicBytes(filePath, ext) {
  try {
    const buffer = Buffer.alloc(12);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 12);
    fs.closeSync(fd);

    const signature = buffer.toString('hex').substring(0, 16);

    // Magic byte signatures for common formats
    const MAGIC_BYTES = {
      '.mp4': ['66747970'], // 'ftyp' in hex
      '.mov': ['6674797020717420', '6d6f6f76'], // 'ftyp qt' or 'mooov'
      '.wav': ['52494646', '57415645'], // 'RIFF' + 'WAVE'
      '.mp3': ['fff3', 'fff2', '49443'], // MP3 sync or ID3 tag
      '.mxf': ['060e2b34', '02b16200'],
      '.aac': ['fff1', 'fff9', 'adif'],
    };

    const expectedSignatures = MAGIC_BYTES[ext] || [];
    const isValid = expectedSignatures.some(sig => 
      signature.includes(sig) || signature.startsWith(sig)
    );

    if (!isValid) {
      return {
        isValid: false,
        error: `File signature mismatch for ${ext}. File may be corrupted or spoofed.`,
      };
    }

    return { isValid: true, mimeType: EXTENSION_TO_MIME[ext] };
  } catch (error) {
    return { 
      isValid: false, 
      error: `Failed to validate file signature: ${error.message}` 
    };
  }
}

/**
 * Checks if file has minimum duration using ffprobe metadata
 * @param {object} metadata - Metadata from ffprobe (duration field)
 * @param {number} minDurationSeconds - Minimum required duration (default: 1 second)
 * @returns {object} { isValid: boolean, duration: number, error: string }
 */
function validateMinimumDuration(metadata, minDurationSeconds = 1) {
  if (!metadata) {
    return { isValid: false, duration: 0, error: 'No metadata available' };
  }

  const duration = parseFloat(metadata.duration) || 0;

  if (duration < minDurationSeconds) {
    return {
      isValid: false,
      duration,
      error: `File duration (${duration.toFixed(2)}s) is below minimum requirement (${minDurationSeconds}s). Files must be at least ${minDurationSeconds}s long for reliable synchronization.`,
    };
  }

  return { isValid: true, duration, error: null };
}

/**
 * Comprehensive file validation
 * @param {string} filePath - Path to file
 * @param {object} metadata - FFprobe metadata
 * @returns {object} Validation result with all checks
 */
function validateFile(filePath, metadata = null) {
  // Step 1: Validate format
  const formatValidation = validateFileFormat(filePath);
  if (!formatValidation.isValid) {
    return {
      isValid: false,
      error: formatValidation.error,
      mimeType: null,
      duration: 0,
    };
  }

  // Step 2: Validate duration (if metadata provided)
  if (metadata) {
    const durationValidation = validateMinimumDuration(metadata);
    if (!durationValidation.isValid) {
      return {
        isValid: false,
        error: durationValidation.error,
        mimeType: formatValidation.mimeType,
        duration: durationValidation.duration,
      };
    }

    return {
      isValid: true,
      error: null,
      mimeType: formatValidation.mimeType,
      duration: durationValidation.duration,
    };
  }

  // Return partial validation if no metadata provided
  return {
    isValid: true,
    error: null,
    mimeType: formatValidation.mimeType,
    duration: 0,
  };
}

module.exports = {
  validateFile,
  validateFileFormat,
  validateMinimumDuration,
  validateMagicBytes,
  SUPPORTED_MIME_TYPES,
  EXTENSION_TO_MIME,
};
