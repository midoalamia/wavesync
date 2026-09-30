/**
 * Envelope Cache Manager (envelopeCache.js)
 * Caches extracted audio envelope data to avoid redundant processing
 * Uses file hash + modification time for cache invalidation
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

class EnvelopeCache {
  constructor(cacheDir = null) {
    // Default cache directory in temp folder
    this.cacheDir = cacheDir || path.join(require('os').tmpdir(), 'wavesync-envelope-cache');
    this.memoryCache = new Map(); // In-memory cache for current session
    this.initializeCacheDirectory();
  }

  /**
   * Initialize cache directory
   */
  initializeCacheDirectory() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to initialize cache directory:', error);
    }
  }

  /**
   * Generate unique cache key based on file path and modification time
   * @param {string} filePath - Path to audio file
   * @returns {string} Cache key (hash)
   */
  generateCacheKey(filePath) {
    try {
      const stats = fs.statSync(filePath);
      const fileIdentifier = `${filePath}:${stats.mtimeMs}:${stats.size}`;
      return crypto.createHash('sha256').update(fileIdentifier).digest('hex');
    } catch (error) {
      console.error('Failed to generate cache key:', error);
      return null;
    }
  }

  /**
   * Get cache file path from key
   * @param {string} cacheKey - Cache key
   * @returns {string} Path to cache file
   */
  getCacheFilePath(cacheKey) {
    return path.join(this.cacheDir, `${cacheKey}.json`);
  }

  /**
   * Retrieve envelope data from cache (memory first, then disk)
   * @param {string} filePath - Path to audio file
   * @returns {object|null} Cached envelope data or null if not found
   */
  get(filePath) {
    const cacheKey = this.generateCacheKey(filePath);
    if (!cacheKey) return null;

    // Check memory cache first (fastest)
    if (this.memoryCache.has(cacheKey)) {
      console.log(`[CACHE HIT] Memory cache for: ${path.basename(filePath)}`);
      return this.memoryCache.get(cacheKey);
    }

    // Check disk cache
    const cacheFilePath = this.getCacheFilePath(cacheKey);
    if (fs.existsSync(cacheFilePath)) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
        // Restore to memory cache for future access
        this.memoryCache.set(cacheKey, cachedData);
        console.log(`[CACHE HIT] Disk cache for: ${path.basename(filePath)}`);
        return cachedData;
      } catch (error) {
        console.error('Failed to read disk cache:', error);
        // Delete corrupted cache file
        this.invalidate(filePath);
        return null;
      }
    }

    console.log(`[CACHE MISS] No cache found for: ${path.basename(filePath)}`);
    return null;
  }

  /**
   * Store envelope data in cache (memory + disk)
   * @param {string} filePath - Path to audio file
   * @param {object} envelopeData - Envelope data to cache
   * @returns {boolean} Success status
   */
  set(filePath, envelopeData) {
    const cacheKey = this.generateCacheKey(filePath);
    if (!cacheKey) return false;

    try {
      // Store in memory
      this.memoryCache.set(cacheKey, envelopeData);

      // Store on disk
      const cacheFilePath = this.getCacheFilePath(cacheKey);
      fs.writeFileSync(
        cacheFilePath,
        JSON.stringify(envelopeData, null, 2),
        'utf-8'
      );

      console.log(`[CACHE SAVE] Cached envelope for: ${path.basename(filePath)}`);
      return true;
    } catch (error) {
      console.error('Failed to cache envelope data:', error);
      return false;
    }
  }

  /**
   * Invalidate cache for a specific file
   * @param {string} filePath - Path to audio file
   * @returns {boolean} Success status
   */
  invalidate(filePath) {
    const cacheKey = this.generateCacheKey(filePath);
    if (!cacheKey) return false;

    try {
      // Remove from memory
      this.memoryCache.delete(cacheKey);

      // Remove from disk
      const cacheFilePath = this.getCacheFilePath(cacheKey);
      if (fs.existsSync(cacheFilePath)) {
        fs.unlinkSync(cacheFilePath);
        console.log(`[CACHE INVALIDATE] Removed cache for: ${path.basename(filePath)}`);
      }

      return true;
    } catch (error) {
      console.error('Failed to invalidate cache:', error);
      return false;
    }
  }

  /**
   * Clear all cache (memory + disk)
   * @returns {boolean} Success status
   */
  clearAll() {
    try {
      // Clear memory
      this.memoryCache.clear();

      // Clear disk cache
      if (fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir);
        files.forEach(file => {
          fs.unlinkSync(path.join(this.cacheDir, file));
        });
      }

      console.log('[CACHE CLEAR] All cache cleared');
      return true;
    } catch (error) {
      console.error('Failed to clear all cache:', error);
      return false;
    }
  }

  /**
   * Get cache statistics
   * @returns {object} Cache stats
   */
  getStats() {
    try {
      const memoryCacheSize = this.memoryCache.size;
      let diskCacheSize = 0;
      let diskCacheFiles = 0;

      if (fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir);
        diskCacheFiles = files.length;
        files.forEach(file => {
          const filePath = path.join(this.cacheDir, file);
          const stats = fs.statSync(filePath);
          diskCacheSize += stats.size;
        });
      }

      return {
        memoryCacheEntries: memoryCacheSize,
        diskCacheEntries: diskCacheFiles,
        diskCacheSizeBytes: diskCacheSize,
        diskCacheSizeMB: (diskCacheSize / (1024 * 1024)).toFixed(2),
        cacheDirectory: this.cacheDir,
      };
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      return {};
    }
  }

  /**
   * Prune old cache files (keep only last N files by modification time)
   * @param {number} maxEntries - Maximum cache entries to keep
   * @returns {boolean} Success status
   */
  prune(maxEntries = 50) {
    try {
      if (!fs.existsSync(this.cacheDir)) return true;

      const files = fs.readdirSync(this.cacheDir).map(file => ({
        name: file,
        path: path.join(this.cacheDir, file),
        time: fs.statSync(path.join(this.cacheDir, file)).mtimeMs,
      }));

      if (files.length > maxEntries) {
        // Sort by modification time (oldest first)
        files.sort((a, b) => a.time - b.time);

        // Delete oldest files
        const filesToDelete = files.slice(0, files.length - maxEntries);
        filesToDelete.forEach(file => {
          fs.unlinkSync(file.path);
        });

        console.log(`[CACHE PRUNE] Removed ${filesToDelete.length} old cache entries`);
      }

      return true;
    } catch (error) {
      console.error('Failed to prune cache:', error);
      return false;
    }
  }
}

module.exports = EnvelopeCache;
