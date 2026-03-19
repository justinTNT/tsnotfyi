// mixer-broadcast.js
// Serialization, sanitization, and event-recording helpers extracted from DriftAudioMixer.
// All functions are standalone — pure functions take plain data; stateful ones accept
// a mixer (or explicit state bags) and return results rather than mutating where feasible.

// ─── Clone helpers (lifted from DriftAudioMixer) ─────────────────────────────

function cloneFeatureMap(features) {
  if (!features || typeof features !== 'object') return null;
  const clone = {};
  for (const [key, value] of Object.entries(features)) {
    if (value === undefined) continue;
    clone[key] = value;
  }
  return clone;
}

function clonePcaMap(pca) {
  if (!pca || typeof pca !== 'object') return null;
  const clone = {};
  if (pca.primary_d !== undefined) {
    clone.primary_d = pca.primary_d;
  }
  ['tonal', 'spectral', 'rhythmic'].forEach(domain => {
    const domainValue = pca[domain];
    if (Array.isArray(domainValue)) {
      clone[domain] = domainValue.slice();
    } else if (domainValue !== undefined && domainValue !== null) {
      clone[domain] = domainValue;
    }
  });
  return clone;
}

// ─── Pure serialization / sanitization ───────────────────────────────────────

function summarizeTrackMinimal(track) {
  if (!track) {
    return null;
  }

  const identifier = track.identifier || null;
  if (!identifier) {
    return null;
  }

  return {
    identifier,
    title: track.title || null,
    artist: track.artist || null,
    duration: track.length || track.duration || null,
    albumCover: track.albumCover || null
  };
}

function summarizeExplorerSnapshot(explorerData, currentTrackId = null) {
  if (!explorerData) {
    return null;
  }
  const currentId = currentTrackId
    || explorerData.currentTrack?.identifier
    || explorerData.currentTrack?.track?.identifier
    || '';
  const nextId = explorerData.nextTrack?.track?.identifier
    || explorerData.nextTrack?.identifier
    || '';
  const directions = explorerData.directions || {};
  const entries = Object.keys(directions).sort().map((key) => {
    const direction = directions[key] || {};
    const primaryCount = Array.isArray(direction.sampleTracks) ? direction.sampleTracks.length : 0;
    const oppositeCount = Array.isArray(direction.oppositeDirection?.sampleTracks)
      ? direction.oppositeDirection.sampleTracks.length
      : 0;
    return `${key}:${primaryCount}:${oppositeCount}`;
  });
  return `${currentId}::${nextId}::${entries.join('|')}`;
}

function sanitizeTrackForClient(track, options = {}) {
  if (!track || typeof track !== 'object') {
    return null;
  }

  const {
    includeFeatures = true,
    includePca = true
  } = options;

  const duration = Number.isFinite(track.duration)
    ? track.duration
    : (Number.isFinite(track.length) ? track.length : null);

  const payload = {
    identifier: track.identifier,
    title: track.title,
    artist: track.artist,
    album: track.album || null,
    albumCover: track.albumCover || null,
    duration,
    length: duration,
    directionKey: track.directionKey || track.baseDirection || track.dimensionKey || null,
    direction: track.direction || track.baseDirection || null,
    transitionReason: track.transitionReason || track.reason || null
  };

  if (track.stackDirection) {
    payload.stackDirection = track.stackDirection;
  }
  if (track.baseDirection) {
    payload.baseDirection = track.baseDirection;
  }
  if (track.baseDirectionKey) {
    payload.baseDirectionKey = track.baseDirectionKey;
  }
  if (track.startTime) {
    payload.startTime = track.startTime;
  }
  if (track.previewDirectionKey) {
    payload.previewDirectionKey = track.previewDirectionKey;
  }
  if (track.directionMeta) {
    payload.directionMeta = { ...track.directionMeta };
  }

  if (includeFeatures && track.features) {
    const features = cloneFeatureMap(track.features);
    if (features && Object.keys(features).length > 0) {
      payload.features = features;
    }
  }

  if (includePca && track.pca) {
    const pca = clonePcaMap(track.pca);
    if (pca) {
      payload.pca = pca;
    }
  }

  return payload;
}

function sanitizeSampleTrackEntry(entry, options = {}) {
  if (!entry) {
    return null;
  }

  const { includeFeatures = true, includePca = true } = options;
  const track = entry.track || entry;
  const sanitizedTrack = sanitizeTrackForClient(track, { includeFeatures, includePca });
  if (!sanitizedTrack) {
    return null;
  }

  if (entry.track) {
    const wrapper = { ...entry };
    delete wrapper.track;
    delete wrapper.distance;
    delete wrapper.similarity;
    delete wrapper.distanceSlices;
    delete wrapper.featureDistanceSlices;
    delete wrapper.analysis;
    delete wrapper.beets;
    delete wrapper.beetsMeta;
    delete wrapper.features;
    delete wrapper.pca;
    return { ...wrapper, track: sanitizedTrack };
  }

  return sanitizedTrack;
}

function sanitizeSampleTrackList(entries, options = {}) {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries
    .map(entry => sanitizeSampleTrackEntry(entry, options))
    .filter(Boolean);
}

function sanitizeExplorerDirection(direction, options = {}) {
  if (!direction) {
    return direction;
  }

  const sanitized = { ...direction };
  sanitized.sampleTracks = sanitizeSampleTrackList(
    direction.sampleTracks,
    options
  );

  if (direction.oppositeDirection) {
    sanitized.oppositeDirection = {
      ...direction.oppositeDirection,
      sampleTracks: sanitizeSampleTrackList(
        direction.oppositeDirection.sampleTracks,
        options
      )
    };
  }

  delete sanitized.originalSampleTracks;
  delete sanitized.distanceSlices;
  delete sanitized.featureDistanceSlices;
  delete sanitized.analysis;
  delete sanitized.beets;
  delete sanitized.beetsMeta;

  return sanitized;
}

function serializeNextTrackForClient(nextTrack, options = {}) {
  if (!nextTrack) {
    return null;
  }

  if (typeof nextTrack === 'string') {
    return nextTrack;
  }

  const sanitized = { ...nextTrack };
  if (nextTrack.track) {
    sanitized.track = sanitizeTrackForClient(nextTrack.track, options);
  }
  delete sanitized.distanceSlices;
  delete sanitized.featureDistanceSlices;
  delete sanitized.analysis;
  delete sanitized.beets;
  delete sanitized.beetsMeta;
  return sanitized;
}

/**
 * Serialize a full explorer snapshot for client consumption.
 *
 * NOTE: The original method also marks "top of pile" tracks as seen in the
 * mixer's seenTracks / seenTrackArtists / seenTrackAlbums sets.  This version
 * collects those side-effects and returns them in a `seenItems` bag so the
 * caller can apply them.
 *
 * @param {object} explorerData
 * @returns {{ snapshot: object, seenItems: { tracks: string[], artists: string[], albums: string[] } } | null}
 */
function serializeExplorerSnapshotForClient(explorerData) {
  if (!explorerData) {
    return null;
  }

  const sanitized = { ...explorerData };

  if (explorerData.directions) {
    const sanitizedDirections = {};
    for (const [key, direction] of Object.entries(explorerData.directions)) {
      sanitizedDirections[key] = sanitizeExplorerDirection(direction, {
        includeFeatures: true,
        includePca: true
      });
    }
    sanitized.directions = sanitizedDirections;
  }

  // Collect "top of pile" seen-items so the caller can mark them on session state
  const seenItems = { tracks: [], artists: [], albums: [] };

  for (const direction of Object.values(sanitized.directions || {})) {
    const topTrack = direction.sampleTracks?.[0];
    if (topTrack) {
      const id = topTrack.identifier || topTrack.track?.identifier;
      if (id) seenItems.tracks.push(id);
      const artist = topTrack.artist || topTrack.track?.artist;
      if (artist) seenItems.artists.push(artist);
      const album = topTrack.album || topTrack.track?.album;
      if (album) seenItems.albums.push(album);
    }
    const oppositeTop = direction.oppositeDirection?.sampleTracks?.[0];
    if (oppositeTop) {
      const id = oppositeTop.identifier || oppositeTop.track?.identifier;
      if (id) seenItems.tracks.push(id);
      const artist = oppositeTop.artist || oppositeTop.track?.artist;
      if (artist) seenItems.artists.push(artist);
      const album = oppositeTop.album || oppositeTop.track?.album;
      if (album) seenItems.albums.push(album);
    }
  }

  sanitized.nextTrack = serializeNextTrackForClient(
    explorerData.nextTrack,
    { includeFeatures: true, includePca: true }
  );

  if (explorerData.currentTrack) {
    sanitized.currentTrack = sanitizeTrackForClient(
      explorerData.currentTrack,
      { includeFeatures: true, includePca: true }
    );
  }

  return { snapshot: sanitized, seenItems };
}

// ─── State-dependent builders ────────────────────────────────────────────────

/**
 * Build a next-track summary from mixer state.
 * @param {object} mixer — duck-typed mixer instance (needs: lockedNextTrackIdentifier,
 *   pendingUserOverrideDirection, pendingUserOverrideTrackId, lastExplorerSnapshotPayload,
 *   nextTrack, hydrateTrackRecord(), getDisplayCurrentTrack(), summarizeTrackMinimal() — or
 *   we call our own summarizeTrackMinimal)
 */
function buildNextTrackSummary(mixer) {
  let candidate = null;

  // 1. User overrides take precedence
  if (mixer.lockedNextTrackIdentifier) {
    candidate = mixer.hydrateTrackRecord({
      identifier: mixer.lockedNextTrackIdentifier,
      direction: mixer.pendingUserOverrideDirection || null,
      transitionReason: 'user'
    });
  } else if (mixer.pendingUserOverrideTrackId) {
    candidate = mixer.hydrateTrackRecord({
      identifier: mixer.pendingUserOverrideTrackId,
      direction: mixer.pendingUserOverrideDirection || null,
      transitionReason: 'user'
    });
  }
  // 2. Use last-sent snapshot's nextTrack (ensures consistency with what client has)
  //    BUT skip if it matches the current track (stale after promotion)
  else if (mixer.lastExplorerSnapshotPayload?.nextTrack?.track?.identifier) {
    const snapshotNextId = mixer.lastExplorerSnapshotPayload.nextTrack.track.identifier;
    const displayTrackId = mixer.getDisplayCurrentTrack()?.identifier;
    // Skip stale nextTrack that has already been promoted to current
    if (snapshotNextId !== displayTrackId) {
      const snapshotNext = mixer.lastExplorerSnapshotPayload.nextTrack;
      candidate = mixer.hydrateTrackRecord({
        identifier: snapshotNext.track.identifier,
        direction: snapshotNext.direction || null,
        directionKey: snapshotNext.directionKey || null,
        transitionReason: snapshotNext.transitionReason || 'auto'
      });
    }
  }
  // 3. Fallback to computed next (only before first snapshot sent)
  else if (mixer.nextTrack && mixer.nextTrack.identifier) {
    candidate = mixer.hydrateTrackRecord(mixer.nextTrack);
  }

  if (!candidate) {
    return null;
  }

  // Never report the current track as the next track
  const currentId = mixer.state.currentTrack?.identifier;
  if (currentId && candidate.identifier === currentId) {
    return null;
  }

  const summary = summarizeTrackMinimal(candidate);
  if (!summary) {
    return null;
  }

  const direction = candidate.direction || null;
  const directionKey = candidate.directionKey || null;

  return {
    directionKey: directionKey || null,
    direction,
    transitionReason: candidate.transitionReason || (mixer.lockedNextTrackIdentifier === summary.identifier ? 'user' : 'auto'),
    track: summary
  };
}

/**
 * Build a heartbeat payload from mixer state.
 * @param {object} mixer — the mixer instance (duck-typed)
 * @param {string} reason
 * @param {object} deps — external dependencies: { fingerprintRegistry, cloneAndSanitizeBeetsMeta,
 *   HEARTBEAT_DIVERGENCE_THRESHOLD_MS, HEARTBEAT_ELAPSED_OVERSHOOT_WARN_MS }
 * @returns {object|null}
 */
function buildHeartbeatPayload(mixer, reason = 'status', deps = {}) {
  const {
    fingerprintRegistry: fpRegistry,
    cloneAndSanitizeBeetsMeta: sanitizeBeets,
    HEARTBEAT_DIVERGENCE_THRESHOLD_MS = 2000,
    HEARTBEAT_ELAPSED_OVERSHOOT_WARN_MS = 4000
  } = deps;

  const displayTrack = mixer.getDisplayCurrentTrack();
  if (!displayTrack) {
    return null;
  }

  const now = Date.now();
  const displayStartTime = mixer.getDisplayTrackStartTime();
  const liveState = mixer.getLiveStreamState();
  const liveTrackId = liveState?.trackId || null;
  const liveStartTime = Number.isFinite(liveState?.startedAt) ? liveState.startedAt : null;

  let durationSeconds = null;
  if (displayTrack.identifier && mixer.state.currentTrack?.identifier === displayTrack.identifier) {
    durationSeconds = mixer.getAdjustedTrackDuration(mixer.state.currentTrack, { logging: false });
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    durationSeconds = displayTrack.length || displayTrack.duration || null;
  }

  const durationMs = Number.isFinite(durationSeconds) ? Math.max(Math.round(durationSeconds * 1000), 0) : null;
  const visualElapsedMs = Number.isFinite(displayStartTime) ? Math.max(now - displayStartTime, 0) : null;
  const liveElapsedMs = liveStartTime != null ? Math.max(now - liveStartTime, 0) : null;

  let elapsedMs = visualElapsedMs;
  let rebasedVisualStart = false;

  if (liveElapsedMs != null) {
    const trackMismatch = Boolean(displayTrack.identifier && liveTrackId && displayTrack.identifier !== liveTrackId);
    const divergenceMs = visualElapsedMs != null ? Math.abs(liveElapsedMs - visualElapsedMs) : null;
    const shouldUseLiveElapsed =
      trackMismatch ||
      visualElapsedMs == null ||
      (divergenceMs != null && divergenceMs > HEARTBEAT_DIVERGENCE_THRESHOLD_MS);

    if (shouldUseLiveElapsed) {
      elapsedMs = liveElapsedMs;
      if (!trackMismatch && liveStartTime != null && displayTrack.identifier === liveTrackId) {
        if (!Number.isFinite(mixer.state.trackStartTime) || mixer.state.trackStartTime !== liveStartTime) {
          mixer.state.trackStartTime = liveStartTime;
          rebasedVisualStart = true;
        }
      }
      const shouldLogRebase = trackMismatch || rebasedVisualStart || visualElapsedMs == null;
      if (shouldLogRebase) {
        console.warn('\u23F1\uFE0F [timing] Rebased heartbeat elapsed using live stream state', {
          sessionId: mixer.state.sessionId,
          trackId: displayTrack.identifier,
          liveTrackId,
          visualElapsedMs,
          liveElapsedMs,
          divergenceMs,
          reason: trackMismatch ? 'track-mismatch' : (visualElapsedMs == null ? 'visual-missing' : 'divergence')
        });
      }
    }
  }

  const remainingMs = durationMs != null && elapsedMs != null
    ? Math.max(durationMs - Math.min(elapsedMs, durationMs), 0)
    : null;

  if (
    Number.isFinite(durationMs) &&
    Number.isFinite(elapsedMs) &&
    elapsedMs > durationMs + HEARTBEAT_ELAPSED_OVERSHOOT_WARN_MS
  ) {
    console.warn('\u23F1\uFE0F [timing] Heartbeat elapsed exceeds duration', {
      sessionId: mixer.state.sessionId,
      trackId: displayTrack.identifier,
      elapsedMs,
      durationMs,
      overshootMs: Math.round(elapsedMs - durationMs),
      liveTrackId,
      displayTrackId: displayTrack.identifier,
      reason
    });
  }

  if (
    Number.isFinite(durationMs) &&
    Number.isFinite(elapsedMs) &&
    elapsedMs > durationMs
  ) {
    console.warn('\u23F1\uFE0F [timing] Clamping heartbeat elapsed to track duration', {
      sessionId: mixer.state.sessionId,
      trackId: displayTrack.identifier,
      durationMs,
      originalElapsedMs: elapsedMs
    });
    elapsedMs = durationMs;
  }

  const nextSummary = buildNextTrackSummary(mixer);
  const overrideId = mixer.pendingUserOverrideTrackId || mixer.lockedNextTrackIdentifier || null;
  let overrideStatus = null;
  if (overrideId) {
    if (nextSummary?.track?.identifier === overrideId) {
      overrideStatus = 'prepared';
    } else if (mixer.pendingUserOverrideTrackId === overrideId) {
      overrideStatus = 'pending';
    } else {
      overrideStatus = 'locked';
    }
  }

  const beetsMeta = displayTrack.beetsMeta || mixer.lookupTrackBeetsMeta(displayTrack.identifier) || null;

  const canonicalStartTime = liveStartTime ?? displayStartTime ?? null;
  const currentTrackPayload = {
    identifier: displayTrack.identifier,
    title: displayTrack.title,
    artist: displayTrack.artist,
    albumCover: displayTrack.albumCover || mixer.lookupTrackAlbumCover(displayTrack.identifier) || null,
    loved: displayTrack.loved || false,
    startTime: canonicalStartTime,
    durationMs
  };

  if (typeof sanitizeBeets === 'function') {
    const sanitizedBeetsMeta = sanitizeBeets(beetsMeta);
    if (sanitizedBeetsMeta) {
      currentTrackPayload.beetsMeta = sanitizedBeetsMeta;
    }
  }

  const fingerprint = mixer.currentFingerprint
    || (fpRegistry && typeof fpRegistry.getFingerprintForSession === 'function'
      ? fpRegistry.getFingerprintForSession(mixer.state.sessionId)
      : null)
    || null;

  return {
    type: 'heartbeat',
    timestamp: now,
    reason,
    fingerprint,
    currentTrack: currentTrackPayload,
    timing: {
      elapsedMs,
      remainingMs
    },
    nextTrack: nextSummary,
    override: overrideId ? {
      identifier: overrideId,
      status: overrideStatus,
      direction: mixer.pendingUserOverrideDirection || nextSummary?.direction || null
    } : null,
    session: {
      id: mixer.state.sessionId,
      audioClients: mixer.clients.size,
      eventClients: mixer.eventClients.size
    },
    drift: {
      currentDirection: mixer.driftPlayer.currentDirection
    },
    currentTrackDirection: mixer.state.currentTrackDirection || mixer.driftPlayer.currentDirection || null
  };
}

// ─── Event recording helpers ─────────────────────────────────────────────────

/**
 * Record an explorer event into the event history array.
 * Mutates explorerEventHistory in place (push/shift).
 *
 * @param {{ reason: string, explorerData: object, nextTrack: object }} eventInfo
 * @param {{ explorerEventHistory: Array, maxExplorerEventHistory: number,
 *           currentTrack: object|null, sessionEvents: Array, maxSessionEvents: number }} state
 */
function recordExplorerEvent({ reason, explorerData, nextTrack }, state) {
  const diagnostics = explorerData?.diagnostics || null;
  const entry = {
    timestamp: Date.now(),
    reason: reason || 'snapshot',
    trackId: diagnostics?.currentTrackId || state.currentTrack?.identifier || null,
    radius: diagnostics?.radius || null,
    neighborhood: diagnostics?.neighborhood || null,
    directionStats: diagnostics?.directionStats || null,
    retryCount: diagnostics?.retryCount ?? 0,
    nextTrack: null
  };

  if (nextTrack?.track) {
    entry.nextTrack = {
      identifier: nextTrack.track.identifier,
      title: nextTrack.track.title,
      artist: nextTrack.track.artist,
      directionKey: nextTrack.track.directionKey || nextTrack.directionKey || null
    };
  }

  state.explorerEventHistory.push(entry);
  if (state.explorerEventHistory.length > state.maxExplorerEventHistory) {
    state.explorerEventHistory.shift();
  }
  recordSessionEvent('explorer_event', entry, state);
}

/**
 * Record a generic session event.
 * Mutates state.sessionEvents in place.
 *
 * @param {string} type
 * @param {object} data
 * @param {{ sessionEvents: Array, maxSessionEvents: number }} state
 */
function recordSessionEvent(type, data = {}, state) {
  if (!type) {
    return;
  }
  const entry = {
    timestamp: Date.now(),
    type,
    data
  };
  state.sessionEvents.push(entry);
  if (state.sessionEvents.length > state.maxSessionEvents) {
    state.sessionEvents.shift();
  }
}

/**
 * Record a live playback chunk — updates liveStreamState and optionally triggers
 * a heartbeat broadcast on track change.
 *
 * @param {Buffer} chunk
 * @param {object} mixer — the mixer instance (duck-typed: audioMixer, currentTrack,
 *   pendingCurrentTrack, liveStreamState, broadcastHeartbeat())
 * @param {{ validate: Function, MixerMetadata: object }} contracts — Zod contract helpers
 */
function recordLivePlaybackChunk(chunk, mixer, contracts) {
  if (!chunk || !chunk.length) {
    return;
  }

  const { validate, MixerMetadata } = contracts || {};
  const rawMetadata = typeof mixer.audioMixer?.getCurrentPlaybackMetadata === 'function'
    ? mixer.audioMixer.getCurrentPlaybackMetadata()
    : null;
  const metadataResult = (rawMetadata && validate && MixerMetadata)
    ? validate(MixerMetadata, rawMetadata)
    : null;
  const metadata = metadataResult?.success ? metadataResult.data : null;
  const fallbackTrack = mixer.state.currentTrack || mixer.pendingCurrentTrack || null;
  const trackId = metadata?.identifier || fallbackTrack?.identifier || null;

  if (!trackId) {
    return;
  }

  const now = Date.now();
  const changed = trackId !== mixer.liveStreamState.trackId;

  if (changed) {
    const humanLabel = metadata?.title || fallbackTrack?.title || trackId;
    console.log(`\uD83D\uDCE1 Live stream chunk now sourced from ${humanLabel}`);

    // Detect live stream vs session track mismatch (diagnostic only)
    if (metadata?.identifier && mixer.state.currentTrack?.identifier &&
        metadata.identifier !== mixer.state.currentTrack.identifier &&
        metadata.identifier !== mixer.pendingCurrentTrack?.identifier) {
      console.warn('\u26A0\uFE0F Live playback identifier differs from session current track (diagnostic only)', {
        sessionId: mixer.state.sessionId,
        liveTrackId: metadata.identifier,
        liveTitle: metadata.title || null,
        sessionTrackId: mixer.state.currentTrack.identifier,
        sessionTitle: mixer.state.currentTrack.title || null
      });
    }

    // Broadcast heartbeat so clients see the track change
    mixer.broadcastHeartbeat('live-chunk', { force: true }).catch(() => {});
  }

  mixer.liveStreamState = {
    trackId,
    title: metadata?.title || fallbackTrack?.title || null,
    artist: metadata?.artist || fallbackTrack?.artist || null,
    startedAt: changed ? now : (mixer.liveStreamState.startedAt || now),
    lastChunkAt: now,
    chunkBytes: chunk.length
  };
}

// ─── History helpers ─────────────────────────────────────────────────────────

/**
 * Build a history entry and compute seen-artist/album side-effects.
 * Returns the entry plus any seen-sets updates the caller should apply.
 *
 * Also performs the structured transition log (console.log).
 *
 * @param {object} track
 * @param {number} startTimestamp
 * @param {string|null} direction
 * @param {string} transitionReason
 * @param {{ sessionHistory: Array, maxHistorySize: number,
 *           noArtist: boolean, noAlbum: boolean,
 *           sessionId: string,
 *           currentAdaptiveRadius: object|null,
 *           adaptiveRadiusCache: Map|null }} state
 * @returns {{ entry: object, seenArtist: string|null, seenAlbum: string|null }}
 */
function buildHistoryEntry(track, startTimestamp, direction, transitionReason, state) {
  const historyEntry = {
    identifier: track.identifier,
    title: track.title,
    artist: track.artist,
    duration: track.length,
    startTime: startTimestamp,
    direction: direction,
    transitionReason: transitionReason || 'natural',
    features: track.features || {},
    albumCover: track.albumCover || null,
    pca: track.pca || null
  };

  // Push into session history
  state.sessionHistory.push(historyEntry);

  // Structured transition log for offline analysis
  const prevEntry = state.sessionHistory.length >= 2
    ? state.sessionHistory[state.sessionHistory.length - 2]
    : null;
  console.log(JSON.stringify({
    _type: 'track_transition',
    ts: new Date().toISOString(),
    sessionId: state.sessionId,
    seq: state.sessionHistory.length,
    track: {
      id: track.identifier,
      title: track.title,
      artist: track.artist,
      features: track.features || null,
      pca: track.pca || null
    },
    prev: prevEntry ? {
      id: prevEntry.identifier,
      features: prevEntry.features || null
    } : null,
    direction: direction,
    transitionReason: transitionReason || 'natural',
    neighborhood: state.currentAdaptiveRadius
      ? { radius: state.currentAdaptiveRadius.radius, count: state.currentAdaptiveRadius.count }
      : state.adaptiveRadiusCache?.get(track.identifier)
        ? { radius: state.adaptiveRadiusCache.get(track.identifier).radius, count: state.adaptiveRadiusCache.get(track.identifier).count, cached: true }
        : null
  }));

  // Determine which seen-set entries the caller should add
  const seenArtist = (track.artist && state.noArtist) ? track.artist : null;
  const seenAlbum = (track.album && state.noAlbum) ? track.album : null;

  // Keep history size manageable
  if (state.sessionHistory.length > state.maxHistorySize) {
    state.sessionHistory.shift();
  }

  return { entry: historyEntry, seenArtist, seenAlbum };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Clone helpers
  cloneFeatureMap,
  clonePcaMap,

  // Pure serialization / sanitization
  summarizeTrackMinimal,
  summarizeExplorerSnapshot,
  sanitizeTrackForClient,
  sanitizeSampleTrackEntry,
  sanitizeSampleTrackList,
  sanitizeExplorerDirection,
  serializeNextTrackForClient,
  serializeExplorerSnapshotForClient,

  // State-dependent builders
  buildNextTrackSummary,
  buildHeartbeatPayload,

  // Event recording
  recordExplorerEvent,
  recordSessionEvent,
  recordLivePlaybackChunk,

  // History
  buildHistoryEntry
};
