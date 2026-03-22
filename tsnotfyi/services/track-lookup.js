/**
 * TrackLookup — lightweight track index for the Audio server.
 * Replaces radialSearch.kdTree.getTrack() with a flat Map lookup.
 * Loaded at startup from the API server's /internal/track-index endpoint.
 */

class TrackLookup {
  constructor() {
    this._index = new Map();
    this._loaded = false;
  }

  get initialized() {
    return this._loaded;
  }

  get tracks() {
    return [...this._index.values()];
  }

  get trackCount() {
    return this._index.size;
  }

  /**
   * Load track index from API server.
   * @param {string} apiUrl - API server base URL (e.g. http://localhost:3001)
   */
  async loadFromApi(apiUrl) {
    const url = `${apiUrl.replace(/\/$/, '')}/internal/track-index`;
    console.log(`📥 Loading track index from ${url}...`);
    const startTime = Date.now();

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Track index fetch failed: ${resp.status}`);
    }

    const data = await resp.json();
    this._index.clear();

    for (const track of data.tracks) {
      this._index.set(track.identifier, track);
    }

    this._loaded = true;
    const elapsed = Date.now() - startTime;
    console.log(`📥 Track index loaded: ${this._index.size} tracks in ${elapsed}ms`);
  }

  /**
   * Load track index from an in-memory radialSearch instance (embedded mode).
   * @param {object} radialSearch - RadialSearchService with kdTree
   */
  loadFromRadialSearch(radialSearch) {
    this._index.clear();
    const tracks = radialSearch.kdTree?.tracks || [];
    for (const track of tracks) {
      this._index.set(track.identifier, track);
    }
    this._loaded = true;
    console.log(`📥 Track index loaded from local KD-tree: ${this._index.size} tracks`);
  }

  /**
   * Get track by identifier — drop-in replacement for kdTree.getTrack().
   */
  getTrack(identifier) {
    return this._index.get(identifier) || null;
  }

  /**
   * Stats — compatible with radialSearch.getStats()
   */
  getStats() {
    return { total_tracks: this._index.size, initialized: this._loaded };
  }

  /**
   * kdTree-compatible shim for code that accesses this.radialSearch.kdTree.*
   * DirectionalDriftPlayer uses: kdTree.getTrack, kdTree.tracks,
   * kdTree.getDirectionDimension, kdTree.isInDirection
   */
  get kdTree() {
    return this;
  }

  /**
   * Stub — direction dimensions aren't available without the real KD-tree.
   * Returns null so callers fall through to onExplorerNeeded.
   */
  getDirectionDimension() { return null; }
  isInDirection() { return false; }

  /**
   * Get random tracks.
   */
  getRandomTracks(count = 10) {
    const all = this.tracks;
    const result = [];
    const used = new Set();
    while (result.length < count && result.length < all.length) {
      const idx = Math.floor(Math.random() * all.length);
      if (!used.has(idx)) {
        used.add(idx);
        result.push(all[idx]);
      }
    }
    return result;
  }
}

module.exports = TrackLookup;
