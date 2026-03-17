// Explorer data cache — per-session, with TTL and max-entries eviction
// Phase 5: Extracted from drift-audio-mixer.js explorerDataCache Map

class ExplorerCache {
  constructor({ maxEntries = 50, ttlMs = 5 * 60 * 1000 } = {}) {
    this._maxEntries = maxEntries;
    this._ttlMs = ttlMs;
    this._cache = new Map(); // key -> { data, timestamp }
  }

  _key(trackId, resolution) {
    return `${trackId}_${resolution}`;
  }

  _isExpired(entry) {
    return (Date.now() - entry.timestamp) > this._ttlMs;
  }

  _evictIfNeeded() {
    if (this._cache.size < this._maxEntries) return;
    // Evict oldest entry
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this._cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this._cache.delete(oldestKey);
    }
  }

  has(trackId, resolution) {
    const key = this._key(trackId, resolution);
    const entry = this._cache.get(key);
    if (!entry) return false;
    if (this._isExpired(entry)) {
      this._cache.delete(key);
      return false;
    }
    return true;
  }

  get(trackId, resolution) {
    const key = this._key(trackId, resolution);
    const entry = this._cache.get(key);
    if (!entry) return undefined;
    if (this._isExpired(entry)) {
      this._cache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(trackId, resolution, explorerData) {
    const key = this._key(trackId, resolution);
    this._evictIfNeeded();
    this._cache.set(key, {
      data: explorerData,
      timestamp: Date.now()
    });
  }

  invalidate(trackId) {
    const prefix = `${trackId}_`;
    for (const key of this._cache.keys()) {
      if (key.startsWith(prefix)) {
        this._cache.delete(key);
      }
    }
  }

  invalidateAll() {
    this._cache.clear();
  }

  get size() {
    return this._cache.size;
  }

  // Iterable — yields [key, data] pairs (skipping expired), compatible with for..of
  *[Symbol.iterator]() {
    for (const [key, entry] of this._cache) {
      if (!this._isExpired(entry)) {
        yield [key, entry.data];
      }
    }
  }
}

module.exports = ExplorerCache;
