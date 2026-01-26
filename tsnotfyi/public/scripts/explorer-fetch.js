// Explorer fetch - request/response explorer data with playlist exclusions
// Replaces SSE-based explorer snapshot system

import { state } from './globals.js';

let pendingFetch = null;
let lastFetchTrackId = null;
let lastFetchTimestamp = 0;
const FETCH_DEBOUNCE_MS = 200;

/**
 * Fetch explorer data for a track with playlist filtering
 * @param {string} trackId - Track identifier to explore from
 * @param {Object} options - Options
 * @param {string[]} options.playlistTrackIds - Track IDs already in playlist (will be excluded)
 * @param {boolean} options.forceFresh - Skip cache and fetch fresh data
 * @returns {Promise<{directions: Object, currentTrack: Object}>}
 */
export async function fetchExplorer(trackId, options = {}) {
  const { playlistTrackIds = [], forceFresh = false } = options;

  if (!trackId) {
    console.warn('fetchExplorer: No trackId provided');
    return null;
  }

  // Debounce rapid requests for the same track
  const now = Date.now();
  if (!forceFresh && lastFetchTrackId === trackId && now - lastFetchTimestamp < FETCH_DEBOUNCE_MS) {
    if (pendingFetch) {
      return pendingFetch;
    }
  }

  lastFetchTrackId = trackId;
  lastFetchTimestamp = now;

  const requestBody = {
    trackId,
    playlistTrackIds,
    sessionId: state.sessionId || null,
    fingerprint: state.streamFingerprint || null
  };

  console.log(`🎯 Fetching explorer for ${trackId.substring(0, 8)}... (playlist: ${playlistTrackIds.length} tracks)`);

  console.log(`🎯 Explorer fetch request:`, requestBody);

  pendingFetch = fetch('/explorer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  })
    .then(async (response) => {
      console.log(`🎯 Explorer fetch response status: ${response.status}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`🎯 Explorer fetch error response:`, errorText);
        try {
          const error = JSON.parse(errorText);
          throw new Error(error.error || `Explorer fetch failed: ${response.status}`);
        } catch {
          throw new Error(`Explorer fetch failed: ${response.status} - ${errorText}`);
        }
      }
      return response.json();
    })
    .then((data) => {
      console.log(`🎯 Explorer data received: ${Object.keys(data.directions || {}).length} directions`);
      if (Object.keys(data.directions || {}).length === 0) {
        console.warn(`🎯 Explorer returned 0 directions - data:`, data);
      }
      return data;
    })
    .catch((error) => {
      console.error('🎯 Explorer fetch error:', error);
      return null;
    })
    .finally(() => {
      pendingFetch = null;
    });

  return pendingFetch;
}

/**
 * Get playlist track IDs from current state
 * @returns {string[]} Array of track identifiers in the playlist queue
 */
export function getPlaylistTrackIds() {
  const playlist = state.playlist || [];
  return playlist.map(item => item.trackId).filter(Boolean);
}

/**
 * Get all track IDs to exclude from explorer results
 * Includes: session history (past tracks), current track, and playlist (future tracks)
 * @returns {string[]} Array of track identifiers to exclude
 */
export function getExcludedTrackIds() {
  const excluded = new Set();

  // Add session history (tracks already played)
  const history = state.sessionTrackHistory || [];
  history.forEach(id => excluded.add(id));

  // Add current track
  const currentId = state.latestCurrentTrack?.identifier;
  if (currentId) {
    excluded.add(currentId);
  }

  // Add playlist queue (future tracks)
  const playlist = state.playlist || [];
  playlist.forEach(item => {
    if (item.trackId) {
      excluded.add(item.trackId);
    }
  });

  return Array.from(excluded);
}

/**
 * Convenience function to fetch explorer with current playlist state
 * @param {string} trackId - Track to explore from
 * @param {Object} options - Additional options
 * @returns {Promise<{directions: Object, currentTrack: Object}>}
 */
export async function fetchExplorerWithPlaylist(trackId, options = {}) {
  const playlistTrackIds = getExcludedTrackIds();
  return fetchExplorer(trackId, { ...options, playlistTrackIds });
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
  window.fetchExplorer = fetchExplorer;
  window.fetchExplorerWithPlaylist = fetchExplorerWithPlaylist;
  window.getPlaylistTrackIds = getPlaylistTrackIds;
  window.getExcludedTrackIds = getExcludedTrackIds;
}
