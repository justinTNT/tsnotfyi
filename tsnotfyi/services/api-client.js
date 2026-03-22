/**
 * ApiClient — HTTP client for the API server (port 3001).
 * Used by the Web server when config.api.mode === "remote".
 * Replaces direct radialSearch/kdTree calls with HTTP requests.
 */

class ApiClient {
  constructor({ url = 'http://localhost:3001', timeoutMs = 30000 } = {}) {
    this._url = url.replace(/\/$/, '');
    this._timeoutMs = timeoutMs;
    this._trackCache = null; // Lazy-loaded track index
  }

  async _fetch(path, options = {}) {
    const url = `${this._url}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this._timeoutMs);

    try {
      const resp = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`API ${options.method || 'GET'} ${path} returned ${resp.status}: ${body}`);
      }

      return resp.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async _post(path, body, options = {}) {
    return this._fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
      ...options
    });
  }

  // ─── Health ─────────────────────────────────────────────────────────────────

  async health() {
    return this._fetch('/health');
  }

  async waitForReady(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const h = await this.health();
        if (h.kdTreeReady) return true;
      } catch (e) {
        // API server not up yet
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  // ─── Track Lookup ───────────────────────────────────────────────────────────

  async getTrack(identifier) {
    try {
      return await this._fetch(`/track/${identifier}`);
    } catch (e) {
      if (e.message.includes('404')) return null;
      throw e;
    }
  }

  /**
   * Load the full track index for local caching.
   * Returns a Map of identifier → track object.
   */
  async loadTrackIndex() {
    const data = await this._fetch('/internal/track-index', { timeoutMs: 120000 });
    const index = new Map();
    for (const track of data.tracks) {
      index.set(track.identifier, track);
    }
    this._trackCache = index;
    return index;
  }

  /**
   * Get track from local cache (falls back to HTTP if not cached).
   */
  getTrackCached(identifier) {
    if (this._trackCache) {
      return this._trackCache.get(identifier) || null;
    }
    return null;
  }

  // ─── Explorer ───────────────────────────────────────────────────────────────

  async explore(trackId, sessionContext = {}, config = {}) {
    return this._post('/explorer', { trackId, sessionContext, config });
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  async radialSearch(trackId, config = {}) {
    return this._post('/radial-search', { trackId, config });
  }

  async directionalSearch(trackId, direction, config = {}) {
    return this._post('/directional-search', { trackId, direction, config });
  }

  async getNeighbors(trackId, options = {}) {
    const params = new URLSearchParams();
    if (options.embedding) params.set('embedding', options.embedding);
    if (options.radius !== undefined) params.set('radius', options.radius);
    if (options.limit) params.set('limit', options.limit);
    if (options.resolution) params.set('resolution', options.resolution);
    if (options.include_distances) params.set('include_distances', 'true');
    const qs = params.toString();
    return this._fetch(`/kd-tree/neighbors/${trackId}${qs ? '?' + qs : ''}`);
  }

  async batchNeighbors(identifiers, options = {}) {
    return this._post('/kd-tree/batch-neighbors', {
      identifiers,
      embedding: options.embedding || 'auto',
      radius: options.radius,
      limit: options.limit || 50
    });
  }

  async getRandomTracks(count = 10) {
    return this._fetch(`/kd-tree/random-tracks?count=${count}`);
  }

  // ─── PCA ────────────────────────────────────────────────────────────────────

  async getPCADirections() {
    return this._fetch('/pca/directions');
  }

  async getResolutionSettings() {
    return this._fetch('/pca/resolutions');
  }

  async pcaDirectionalSearch(trackId, pcaDomain, pcaComponent, direction, config = {}) {
    return this._post('/pca/directional-search', {
      trackId, pcaDomain, pcaComponent, direction, config
    });
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  async getStats() {
    return this._fetch('/radial-search/stats');
  }
}

module.exports = ApiClient;
