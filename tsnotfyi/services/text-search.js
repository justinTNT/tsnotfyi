/**
 * TextSearchIndex — token prefix index with typo tolerance for in-memory track search.
 * Built once at startup from KD-tree tracks. Replaces PostgreSQL pg_trgm.
 *
 * Query: "nurs with woun" → tokenize → prefix-match each token → intersect → score → rank
 * Typo fallback: if prefix match fails and token ≥ 3 chars, try Levenshtein ≤ 1
 */

class TextSearchIndex {
  constructor() {
    this.sortedTokens = [];      // Sorted unique token strings for binary search
    this.postings = new Map();   // token → Uint32Array of track indices
    this.tracks = [];            // Reference to tracks array
    this.fieldTokens = [];       // Per-track: { title: Set, artist: Set, album: Set, path: Set }
  }

  /**
   * Normalize text: lowercase, strip diacritics, collapse whitespace
   */
  _normalize(text) {
    if (!text) return '';
    return text
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  /**
   * Tokenize text into unique tokens (≥ 2 chars)
   */
  _tokenize(text) {
    const normalized = this._normalize(text);
    const tokens = normalized.split(/[^a-z0-9]+/).filter(t => t.length >= 2);
    return new Set(tokens);
  }

  /**
   * Build the search index from tracks array.
   * Called once at startup.
   */
  buildIndex(tracks) {
    const startMs = Date.now();
    this.tracks = tracks;
    this.fieldTokens = new Array(tracks.length);

    // Phase 1: tokenize all tracks, build raw posting lists
    const rawPostings = new Map(); // token → [trackIndex, ...]

    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const titleTokens = this._tokenize(t.title);
      const artistTokens = this._tokenize(t.artist);
      const albumTokens = this._tokenize(t.album);
      const pathTokens = this._tokenize(t.path);

      this.fieldTokens[i] = { title: titleTokens, artist: artistTokens, album: albumTokens, path: pathTokens };

      // Collect all unique tokens for this track
      const allTokens = new Set([...titleTokens, ...artistTokens, ...albumTokens, ...pathTokens]);
      for (const token of allTokens) {
        let list = rawPostings.get(token);
        if (!list) {
          list = [];
          rawPostings.set(token, list);
        }
        list.push(i);
      }
    }

    // Phase 2: sort tokens and convert posting lists to typed arrays
    this.sortedTokens = Array.from(rawPostings.keys()).sort();

    this.postings = new Map();
    for (const token of this.sortedTokens) {
      this.postings.set(token, new Uint32Array(rawPostings.get(token)));
    }

    const elapsedMs = Date.now() - startMs;
    console.log(`🔍 TextSearchIndex built: ${tracks.length} tracks, ${this.sortedTokens.length} unique tokens in ${elapsedMs}ms`);
  }

  /**
   * Binary search for the first token in sortedTokens that starts with prefix.
   * Returns the index, or -1 if no match.
   */
  _prefixLowerBound(prefix) {
    let lo = 0, hi = this.sortedTokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedTokens[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Find all tokens starting with the given prefix.
   * Returns array of matching tokens.
   */
  _prefixMatch(prefix) {
    const matches = [];
    const start = this._prefixLowerBound(prefix);
    for (let i = start; i < this.sortedTokens.length; i++) {
      const token = this.sortedTokens[i];
      if (token.startsWith(prefix)) {
        matches.push(token);
      } else {
        break; // Sorted, so no more matches
      }
    }
    return matches;
  }

  /**
   * Levenshtein distance (bounded — returns early if > maxDist)
   */
  _levenshtein(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

    const m = a.length, n = b.length;
    // Single-row optimization
    let prev = new Uint8Array(n + 1);
    let curr = new Uint8Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let rowMin = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > maxDist) return maxDist + 1;
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  /**
   * Find tokens within Levenshtein distance 1 of the query token.
   * Only scans tokens of similar length to keep it fast.
   */
  _fuzzyMatch(queryToken) {
    const matches = [];
    const qLen = queryToken.length;

    for (const token of this.sortedTokens) {
      // Only check tokens within ±1 character length
      if (token.length < qLen - 1 || token.length > qLen + 1) continue;
      if (this._levenshtein(queryToken, token, 1) <= 1) {
        matches.push(token);
      }
    }
    return matches;
  }

  /**
   * Union multiple Uint32Arrays (posting lists) into a Set of track indices.
   */
  _unionPostings(tokens) {
    const result = new Set();
    for (const token of tokens) {
      const posting = this.postings.get(token);
      if (posting) {
        for (let i = 0; i < posting.length; i++) {
          result.add(posting[i]);
        }
      }
    }
    return result;
  }

  /**
   * Intersect an array of Sets. Smallest-first optimization.
   */
  _intersectSets(sets) {
    if (sets.length === 0) return new Set();
    if (sets.length === 1) return sets[0];

    // Sort by size ascending
    sets.sort((a, b) => a.size - b.size);

    let result = sets[0];
    for (let i = 1; i < sets.length; i++) {
      const next = new Set();
      for (const val of result) {
        if (sets[i].has(val)) next.add(val);
      }
      result = next;
      if (result.size === 0) break;
    }
    return result;
  }

  /**
   * Score a track against query tokens.
   * Higher = better match.
   */
  _scoreTrack(trackIndex, queryTokens, matchTypes) {
    const ft = this.fieldTokens[trackIndex];
    let score = 0;

    for (let q = 0; q < queryTokens.length; q++) {
      const qt = queryTokens[q];
      const matchType = matchTypes[q]; // 'exact', 'prefix', or 'fuzzy'
      const typeWeight = matchType === 'exact' ? 3 : matchType === 'prefix' ? 2 : 1;

      // Field weights: title > artist > album > path
      if (this._fieldContains(ft.title, qt)) score += 10 * typeWeight;
      else if (this._fieldContains(ft.artist, qt)) score += 8 * typeWeight;
      else if (this._fieldContains(ft.album, qt)) score += 5 * typeWeight;
      else if (this._fieldContains(ft.path, qt)) score += 2 * typeWeight;
    }

    return score;
  }

  /**
   * Check if a field's token set contains a token matching the query (exact or prefix).
   */
  _fieldContains(fieldTokens, queryToken) {
    if (fieldTokens.has(queryToken)) return true;
    for (const ft of fieldTokens) {
      if (ft.startsWith(queryToken)) return true;
    }
    return false;
  }

  /**
   * Search the index.
   * @param {string} query - Search query
   * @param {number} limit - Max results
   * @returns {Array<{track, score}>}
   */
  search(query, limit = 20) {
    const queryTokens = Array.from(this._tokenize(query));
    if (queryTokens.length === 0) return [];

    const candidateSets = [];
    const matchTypes = []; // per query token: 'exact', 'prefix', or 'fuzzy'

    for (const qt of queryTokens) {
      // Try exact match first
      if (this.postings.has(qt)) {
        candidateSets.push(new Set(this.postings.get(qt)));
        matchTypes.push('exact');
        continue;
      }

      // Try prefix match
      const prefixMatches = this._prefixMatch(qt);
      if (prefixMatches.length > 0) {
        candidateSets.push(this._unionPostings(prefixMatches));
        matchTypes.push('prefix');
        continue;
      }

      // Typo tolerance: Levenshtein ≤ 1 for tokens ≥ 3 chars
      if (qt.length >= 3) {
        const fuzzyMatches = this._fuzzyMatch(qt);
        if (fuzzyMatches.length > 0) {
          candidateSets.push(this._unionPostings(fuzzyMatches));
          matchTypes.push('fuzzy');
          continue;
        }
      }

      // No match at all for this token — intersection will be empty
      return [];
    }

    // Intersect all candidate sets (AND semantics)
    const intersection = this._intersectSets(candidateSets);
    if (intersection.size === 0) return [];

    // Score and rank
    const scored = [];
    for (const trackIndex of intersection) {
      scored.push({
        track: this.tracks[trackIndex],
        score: this._scoreTrack(trackIndex, queryTokens, matchTypes)
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

module.exports = TextSearchIndex;
