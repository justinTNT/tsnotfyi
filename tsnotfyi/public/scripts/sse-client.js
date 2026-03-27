// SSE client - Server-Sent Events connection and message handling
import { state, connectionHealth, audioHealth, TRACK_SWITCH_PROGRESS_THRESHOLD } from './globals.js';
import { createLogger } from './log.js';
import { composeEventsEndpoint, syncEventsEndpoint, normalizeResolution } from './session-utils.js';
import { requestSSERefresh, createNewJourneySession, scheduleHeartbeat } from './sync-manager.js';
import { armExplorerSnapshotTimer, clearExplorerSnapshotTimer, setDeckStaleFlag } from './deck-state.js';
import { exitCardsDormantState, ensureDeckHydratedAfterTrackChange } from './card-state.js';
import { cloneExplorerData, explorerContainsTrack, findTrackInExplorer, shouldIgnoreExplorerUpdate, summarizeExplorerSnapshot } from './explorer-utils.js';
import { startProgressAnimationFromPosition, maybeApplyDeferredNextTrack, getVisualProgressFraction } from './progress-ui.js';
import { updateConnectionHealthUI, handleDeadAudioSession, getBufferDelaySecs } from './audio-manager.js';
import { popPlaylistHead, playlistHasItems, getPlaylistNext, renderPlaylistTray, cacheTrackMeta } from './playlist-tray.js';
import { setSelection, clearSelection, isUserSelection } from './selection.js';

const sseLog = createLogger('sse');
const syncLog = createLogger('sync');

// Smart SSE connection with health monitoring and reconnection
export function connectSSE() {
  const eventsUrl = composeEventsEndpoint();
  syncEventsEndpoint();
  state.awaitingSSE = false;

  sseLog.info(`🔌 Connecting SSE (session: ${state.sessionId || 'pending'})`);

  connectionHealth.sse.status = 'connecting';
  updateConnectionHealthUI();

  // Close existing connection if any
  if (connectionHealth.currentEventSource) {
    connectionHealth.currentEventSource.close();
  }

  const eventSource = new EventSource(eventsUrl);
  connectionHealth.currentEventSource = eventSource;

  const handleSseStuck = async () => {
    if (!state.sessionId) {
      sseLog.warn('📡 SSE stuck but sessionId not yet assigned; waiting for session');
      return true;
    }

    const ok = await requestSSERefresh({ escalate: false });
    return !ok;
  };

  const resetStuckTimer = () => {
    if (connectionHealth.sse.stuckTimeout) {
      clearTimeout(connectionHealth.sse.stuckTimeout);
    }
    connectionHealth.sse.stuckTimeout = setTimeout(async () => {
      const shouldReconnect = await handleSseStuck();
      if (shouldReconnect) {
        sseLog.warn('📡 SSE stuck check: forcing reconnect');
        connectionHealth.sse.status = 'reconnecting';
        updateConnectionHealthUI();
        eventSource.close();
        setTimeout(() => connectSSE(), 1000);
      } else {
        resetStuckTimer();
      }
    }, 60000);
  };

  const simpleBody = state.sessionId
    ? { sessionId: state.sessionId }
    : null;

  const handleHeartbeat = (heartbeat) => {
    if (!heartbeat || !heartbeat.currentTrack) {
      syncLog.warn('⚠️ Heartbeat missing currentTrack payload');
      return;
    }

    const currentTrack = heartbeat.currentTrack;
    const currentTrackId = currentTrack.identifier || null;

    // Compute duration and start time first (needed by trackChanged block)
    let newDurationSeconds = 0;
    if (Number.isFinite(currentTrack.durationMs)) {
      newDurationSeconds = Math.max(currentTrack.durationMs / 1000, 0);
    } else if (Number.isFinite(currentTrack.duration || currentTrack.length)) {
      newDurationSeconds = currentTrack.duration || currentTrack.length || 0;
    }

    let newStartTimestamp = null;
    if (currentTrack.startTime) {
      newStartTimestamp = currentTrack.startTime;
    } else if (Number.isFinite(heartbeat.timing?.elapsedMs)) {
      newStartTimestamp = Date.now() - heartbeat.timing.elapsedMs;
    }

    // Track change detection
    const previousServerTrackId = state._serverCurrentTrack?.identifier || state.latestCurrentTrack?.identifier || null;
    const trackChanged = Boolean(currentTrackId && previousServerTrackId && currentTrackId !== previousServerTrackId);

    if (trackChanged) {
      const clientBuffer = getBufferDelaySecs();
      syncLog.info(`🔄 Heartbeat track change: ${previousServerTrackId?.substring(0, 8)} → ${currentTrackId?.substring(0, 8)} (clientBuffer: ${clientBuffer.toFixed(1)}s)`);
    }

    // Resolve metadata from cache — heartbeat now only carries identifier + timing.
    // Priority: existing card state > localStorage cache > in-memory cache
    const cachedMeta = (typeof getCachedTrackMeta === 'function' ? getCachedTrackMeta(currentTrackId) : null)
      || state.trackMetadataCache?.[currentTrackId]
      || {};
    const prevState = state.latestCurrentTrack;
    const prevLoved = prevState?.loved;
    const prevHated = prevState?.hated;

    const newTrackState = {
      identifier: currentTrackId,
      title: currentTrack.title || cachedMeta.title || prevState?.title || '',
      artist: currentTrack.artist || cachedMeta.artist || prevState?.artist || '',
      album: currentTrack.album || cachedMeta.album || prevState?.album || '',
      albumCover: currentTrack.albumCover || cachedMeta.albumCover || prevState?.albumCover || '/images/albumcover.png',
      duration: newDurationSeconds || currentTrack.duration || cachedMeta.duration || null,
      length: newDurationSeconds || currentTrack.duration || cachedMeta.duration || null,
      startTime: currentTrack.startTime || null,
      durationMs: currentTrack.durationMs || null
    };
    if (prevLoved !== undefined && currentTrackId === prevState?.identifier) {
      newTrackState.loved = prevLoved;
      newTrackState.hated = prevHated;
    }

    // Update server state and history on track change
    if (trackChanged) {
      // Don't reset playbackDurationSeconds or playbackStartTimestamp here —
      // the sentinel owns progress resets. Setting them on heartbeat would reset
      // the counter while the old track is still audibly playing (buffered audio).
      state._serverCurrentTrack = newTrackState;

      // Cache metadata — history push happens in updateNowPlayingCard (single writer)
      if (!state.trackMetadataCache) state.trackMetadataCache = {};
      state.trackMetadataCache[currentTrackId] = newTrackState;
      if (typeof cacheTrackMeta === 'function') cacheTrackMeta(currentTrackId, newTrackState);
      if (typeof window.renderSessionHistory === 'function') window.renderSessionHistory();
    }

    // Backfill: if cache has no metadata for this track, fetch from server
    if (!cachedMeta.title && !(prevState?.title && prevState?.identifier === currentTrackId) && currentTrackId) {
      fetch(`/track/${currentTrackId}/meta`).then(r => r.ok ? r.json() : null).then(data => {
        if (data?.track) {
          if (!state.trackMetadataCache) state.trackMetadataCache = {};
          state.trackMetadataCache[currentTrackId] = data.track;
          if (typeof cacheTrackMeta === 'function') cacheTrackMeta(currentTrackId, data.track);
          // Update card if this is still the current track
          if (state.latestCurrentTrack?.identifier === currentTrackId) {
            Object.assign(state.latestCurrentTrack, {
              title: data.track.title || state.latestCurrentTrack.title,
              artist: data.track.artist || state.latestCurrentTrack.artist,
              album: data.track.album || state.latestCurrentTrack.album,
              albumCover: data.track.albumCover || state.latestCurrentTrack.albumCover
            });
            if (typeof window.updateNowPlayingCard === 'function') {
              window.updateNowPlayingCard(state.latestCurrentTrack, null);
            }
          }
        }
      }).catch(() => {});
    }

    // === STEADY-STATE: apply state for non-track-change heartbeats ===
    // Track changes are handled by the sentinel callback in page.js.
    // Heartbeats that report a different track are ignored for presentation —
    // the sentinel will fire at the exact audio boundary.

    if (!trackChanged) {
      if (newDurationSeconds) state.playbackDurationSeconds = newDurationSeconds;
      // Only set start timestamp if not already tracking — don't reset mid-track
      if (newStartTimestamp && !state.playbackStartTimestamp) state.playbackStartTimestamp = newStartTimestamp;
      // Don't update latestCurrentTrack here — it's owned by updateNowPlayingCard.
      state.lastTrackUpdateTs = Date.now();

      // If duration is still 0 or 1 (missing from heartbeat), fetch from metadata
      if (state.playbackDurationSeconds <= 1 && currentTrackId && !state._durationFetchInFlight) {
        state._durationFetchInFlight = currentTrackId;
        fetch(`/track/${currentTrackId}/meta`).then(r => (r.ok && r.status !== 204) ? r.json() : null).then(data => {
          if (data?.track?.duration && state.latestCurrentTrack?.identifier === currentTrackId) {
            syncLog.info(`🎵 Duration resolved from meta: ${data.track.duration.toFixed(1)}s`);
            state.playbackDurationSeconds = data.track.duration;
            if (state.latestCurrentTrack) {
              state.latestCurrentTrack.duration = data.track.duration;
              state.latestCurrentTrack.length = data.track.duration;
            }
            startProgressAnimationFromPosition(data.track.duration, 0, { resync: true, trackId: currentTrackId });
          }
        }).catch(() => {}).finally(() => { state._durationFetchInFlight = null; });
      }
    }

    // === IMMEDIATE BOOKKEEPING on track change (no visual effect) ===
    // Playlist pop is deferred to the sentinel handler (page.js onSentinel) so the
    // cover stays in the tray until it appears on the card. But if the sentinel
    // doesn't handle it within a few seconds, pop here as a fallback.
    if (trackChanged && currentTrackId) {
      // DON'T reset progress here — the heartbeat arrives instantly via SSE but the audio
      // is still buffered. The sentinel fires when the crossfade actually reaches the
      // speakers. Resetting progress on heartbeat would show 0:00 for the new track
      // while the old track is still audibly playing.
      // The sentinel handler (page.js) owns the progress reset.

      // Stash the heartbeat's track data for deferred fallback.
      // The sentinel handler is the primary path for card update + tray pop.
      // The server broadcasts immediately; the client waits for the sentinel.
      // Fallback timeout = client buffer depth + margin, so we wait long enough
      // for the buffered audio to play through to the transition point.
      if (state._deferredPlaylistPopTimer) clearTimeout(state._deferredPlaylistPopTimer);
      const fallbackTrackState = newTrackState;
      const fallbackDriftState = heartbeat.driftState || heartbeat.drift || null;
      const fallbackDurationSeconds = newDurationSeconds;
      const fallbackStartTimestamp = newStartTimestamp;
      state._deferredPlaylistPopTimer = setTimeout(() => {
        state._deferredPlaylistPopTimer = null;

        // Sentinel owns card updates. Fallback only handles playlist pop.
        // Pop playlist head if it matches
        if (playlistHasItems()) {
          const head = getPlaylistNext();
          if (head && head.trackId === currentTrackId) {
            syncLog.info(`🎵 Playlist pop fallback: popping ${currentTrackId.substring(0, 8)} from tray`);
            popPlaylistHead();
            renderPlaylistTray();
            const newHead = getPlaylistNext();
            if (newHead && typeof window.sendNextTrack === 'function') {
              window.sendNextTrack(newHead.trackId, newHead.directionKey, 'user');
            }
          }
        }

        // Don't reset progress here — if the sentinel fired, progress is already running.
        // If the sentinel never fired, the card hasn't changed either, so resetting
        // progress would restart the counter on a track that's been playing for 30s+.

        if (!playlistHasItems()) {
          armExplorerSnapshotTimer(currentTrackId, { reason: 'heartbeat-fallback-track-change' });
        }
      }, Math.max(30000, Math.round(getBufferDelaySecs() * 1000) + 5000));

      // History push handled by updateNowPlayingCard (single writer)
    }

    // === FIRST-TRACK DETECTION (no sentinel for the very first track) ===
    // Only fire if we genuinely have no track showing — not on SSE reconnects
    const isFirstTrack = !previousServerTrackId && currentTrackId && !state.latestCurrentTrack?.identifier;
    if (isFirstTrack) {
      state.pendingSnapshotTrackId = currentTrackId;
      armExplorerSnapshotTimer(currentTrackId, { reason: 'heartbeat-first-track' });
      state.currentTrackDirection = heartbeat.currentTrackDirection || null;

      // Show now-playing card — updateNowPlayingCard detects the track change
      // (prevId=null → newId), pushes history, and starts progress.
      // Don't set latestCurrentTrack before the call — it reads it as "prev".
      state.awaitingInitialExplorer = true;
      sseLog.info(`🎵 First track detected — showing card now, explorer loading in background`);

      if (typeof window.updateNowPlayingCard === 'function') {
        window.updateNowPlayingCard(newTrackState, null);
      }

      // If duration is missing, fetch metadata and re-update card with real duration
      if (!newTrackState.duration && currentTrackId) {
        fetch(`/track/${currentTrackId}/meta`).then(r => (r.ok && r.status !== 204) ? r.json() : null).then(data => {
          if (data?.track?.duration && state.latestCurrentTrack?.identifier === currentTrackId) {
            sseLog.info(`🎵 First track enriched: duration=${data.track.duration}s`);
            Object.assign(state.latestCurrentTrack, {
              title: data.track.title || state.latestCurrentTrack.title,
              artist: data.track.artist || state.latestCurrentTrack.artist,
              album: data.track.album || state.latestCurrentTrack.album,
              albumCover: data.track.albumCover || state.latestCurrentTrack.albumCover,
              duration: data.track.duration,
              length: data.track.duration
            });
            // Restart progress with real duration
            state.playbackDurationSeconds = data.track.duration;
            startProgressAnimationFromPosition(data.track.duration, 0, { resync: false, trackChanged: true, trackId: currentTrackId });
          }
        }).catch(err => { sseLog.error(`🎵 First track meta fetch failed: ${err.message}`); });
      }
    }

    // === NEXT-TRACK / OVERRIDE STATE (kept — not track-change logic) ===

    const nextTrackId = heartbeat.nextTrack?.track?.identifier || heartbeat.nextTrack?.identifier || null;
    const nextTrackValid = nextTrackId && nextTrackId !== currentTrackId;
    if (nextTrackValid) {
      state.serverNextTrack = nextTrackId;
      state.serverNextDirection = heartbeat.nextTrack?.direction || heartbeat.nextTrack?.directionKey || null;
      if (!isUserSelection()) {
        const alreadySelected = state.selection.trackId === nextTrackId;
        setSelection(nextTrackId, 'server');

        if (!alreadySelected) {
          const match = findTrackInExplorer(state.latestExplorerData, nextTrackId);
          if (match?.track && match?.direction && typeof window.updateCardWithTrackDetails === 'function') {
            const centerCard = document.querySelector('.dimension-card.next-track');
            if (centerCard) {
              window.updateCardWithTrackDetails(centerCard, match.track, match.direction, true);
            }
          }
        }

        if (typeof window.updatePlaylistTrayPreview === 'function') {
          window.updatePlaylistTrayPreview();
        }
      }

    } else if (nextTrackId && nextTrackId === currentTrackId) {
      syncLog.warn('⚠️ Heartbeat nextTrack === currentTrack (server bug); ignoring', {
        trackId: nextTrackId.substring(0, 8)
      });
    }

    const overrideInfo = heartbeat.override || null;
    if (overrideInfo && overrideInfo.identifier) {
      const overrideId = overrideInfo.identifier;
      if (overrideInfo.status === 'pending' || overrideInfo.status === 'prepared' || overrideInfo.status === 'locked') {
        if (!state.selection.trackId || state.selection.trackId === state.serverNextTrack) {
          const alreadySelected = state.selection.trackId === overrideId;
          setSelection(overrideId, 'ack');

          if (!alreadySelected) {
            const match = findTrackInExplorer(state.latestExplorerData, overrideId);
            if (match?.track && match?.direction && typeof window.updateCardWithTrackDetails === 'function') {
              const centerCard = document.querySelector('.dimension-card.next-track');
              if (centerCard) {
                window.updateCardWithTrackDetails(centerCard, match.track, match.direction, true);
              }
            }
          }
        }
      }
    }

    // Heartbeats do NOT update the card. The sentinel is the sole owner of card presentation.
    // This eliminates the entire class of heartbeat/sentinel racing bugs.

    // Track crossfade readiness in state (survives DOM rebuilds)
    if (playlistHasItems()) {
      const reason = heartbeat.reason || '';
      const nextReady = reason.includes('next-prepared') || !!heartbeat.nextTrack;
      if (nextReady !== state._trayHeadReady) {
        state._trayHeadReady = nextReady;
        // Update the DOM class directly — no full re-render needed
        const trayHead = document.querySelector('.playlist-strip .playlist-cover');
        if (trayHead) {
          trayHead.classList.toggle('xfade-pending', !nextReady);
          trayHead.classList.toggle('xfade-ready', nextReady);
        }
      }
    }
  };

  const handleSelectionAck = (event) => {
    const trackId = event.trackId || event.track?.identifier || null;
    if (!trackId) {
      return;
    }

    sseLog.info('🛰️ selection_ack', event);

    setSelection(trackId, 'ack', event.direction || null);

    const match = findTrackInExplorer(state.latestExplorerData, trackId);

    // Update center card with full track details (title, image, trackMd5, etc.)
    const centerCard = document.querySelector('.dimension-card.next-track');
    if (centerCard && match?.track && match?.direction) {
      if (typeof window.updateCardWithTrackDetails === 'function') {
        window.updateCardWithTrackDetails(centerCard, match.track, match.direction, true);
      }
      // Only refresh cards if we successfully updated the center card
      if (typeof window.refreshCardsWithNewSelection === 'function') {
        window.refreshCardsWithNewSelection();
      }
    } else {
      // Track not in explorer — don't touch the center card. The playlist tray
      // owns next-track state; the center card shows post-playlist explorer options.
      sseLog.info(`🛰️ selection_ack: track ${trackId.substring(0,8)} not in explorer, leaving center card alone`);
    }
  };

  const handleSelectionReady = (event) => {
    const trackId = event.trackId || null;
    sseLog.info('🛰️ selection_ready', event);

    if (trackId) {
      findTrackInExplorer(state.latestExplorerData, trackId);

      if (state.selection.pendingTrackId === trackId) {
        setSelection(trackId, 'ack');
      }
    }
  };

  const handleSelectionFailed = (event) => {
    sseLog.warn('🛰️ selection_failed', event);
    const failedTrack = event.trackId || null;

    if (!failedTrack || state.selection.pendingTrackId === failedTrack) {
      clearSelection('selection_failed');
    }

    requestSSERefresh({ escalate: false });
  };

  const handleExplorerSnapshot = (snapshot) => {
    if (!snapshot) {
      return;
    }
    const previousExplorerData = state.latestExplorerData;
    const preservedNextTrack = previousExplorerData?.nextTrack || null;
    const previousNextTrackId = preservedNextTrack?.track?.identifier || preservedNextTrack?.identifier || null;

    state.lastSSEMessageTime = Date.now();
    state.lastExplorerPayload = cloneExplorerData(snapshot);

    const previousTrackId = state.latestCurrentTrack?.identifier || null;
    const snapshotTrackId = snapshot.currentTrack?.identifier || null;
    const currentTrackId = snapshotTrackId || previousTrackId;
    const trackChanged = Boolean(currentTrackId && previousTrackId && currentTrackId !== previousTrackId);
    if (snapshot.currentTrack?.identifier) {
      clearExplorerSnapshotTimer(snapshot.currentTrack.identifier);
    } else if (state.pendingSnapshotTrackId) {
      clearExplorerSnapshotTimer(state.pendingSnapshotTrackId);
    } else {
      clearExplorerSnapshotTimer(null);
    }
    setDeckStaleFlag(false, { reason: 'explorer-snapshot' });

    if (snapshot.currentTrack) {
      state.latestCurrentTrack = snapshot.currentTrack;
      window.state.latestCurrentTrack = snapshot.currentTrack;
      state.lastTrackUpdateTs = Date.now();
    }

    if (trackChanged && currentTrackId) {
      state.pendingSnapshotTrackId = null;
    }

    if (trackChanged) {
      sseLog.info('🟡 DIAG: Track changed!', { from: previousTrackId, to: currentTrackId, hasExplorer: !!snapshot.explorer });
      exitCardsDormantState({ immediate: true });
      if (typeof window.hideNextTrackPreview === 'function') {
        window.hideNextTrackPreview({ immediate: false });
      }
    } else if (state.cardsDormant) {
      if (typeof window.resolveNextTrackData === 'function') {
        const info = window.resolveNextTrackData();
        if (info?.track && typeof window.showNextTrackPreview === 'function') {
          window.showNextTrackPreview(info.track);
        }
      }
    }

    const rawResolution = snapshot.explorer?.resolution;
    const previousResolution = state.currentResolution;
    const normalizedResolution = normalizeResolution(rawResolution);
    const resolutionChanged = Boolean(normalizedResolution && normalizedResolution !== previousResolution);
    if (resolutionChanged) {
      state.currentResolution = normalizedResolution;
      if (typeof window.updateRadiusControlsUI === 'function') {
        window.updateRadiusControlsUI();
      }
    }

    const explorerNextTrackId = snapshot.explorer?.nextTrack?.track?.identifier
      || snapshot.explorer?.nextTrack?.identifier
      || null;
    const inferredTrack = explorerNextTrackId
      || snapshot.explorer?.nextTrack?.identifier
      || snapshot.nextTrack?.track?.identifier
      || snapshot.nextTrack?.identifier
      || null;

    if (inferredTrack) {
      state.serverNextTrack = inferredTrack;
      state.serverNextDirection = snapshot.explorer?.nextTrack?.direction || snapshot.nextTrack?.direction || null;
    }

    const progressFraction = getVisualProgressFraction();
    if (state.pendingExplorerNext && progressFraction !== null && progressFraction >= TRACK_SWITCH_PROGRESS_THRESHOLD) {
      maybeApplyDeferredNextTrack('snapshot-progress', { force: true });
    }

    let shouldDeferExplorerNext = false;
    if (
      explorerNextTrackId &&
      previousNextTrackId &&
      explorerNextTrackId !== previousNextTrackId &&
      !trackChanged &&
      !isUserSelection() &&
      progressFraction !== null &&
      progressFraction < TRACK_SWITCH_PROGRESS_THRESHOLD
    ) {
      shouldDeferExplorerNext = true;
      state.pendingExplorerNext = {
        nextTrack: JSON.parse(JSON.stringify(snapshot.explorer.nextTrack)),
        selectionId: explorerNextTrackId,
        directionKey: snapshot.explorer.nextTrack.directionKey || snapshot.explorer.nextTrack.direction || null
      };
    } else if (trackChanged) {
      state.pendingExplorerNext = null;
    }

    const allowSelectionUpdate = !shouldDeferExplorerNext;

    const manualSelectionId = isUserSelection() ? state.selection.trackId : null;
    if (trackChanged && isUserSelection() && manualSelectionId && currentTrackId && currentTrackId !== manualSelectionId) {
      sseLog.warn('🛰️ ACTION override-diverged', {
        manualSelection: manualSelectionId,
        playing: currentTrackId,
        manualDirection: state.selection.directionKey,
        serverSuggestedNext: inferredTrack || null
      });
        scheduleHeartbeat(10000);
    }
    if (trackChanged) {
      // Track changed — always clear manual override. Its purpose is to protect
      // user selections *during* a track, not to persist across track boundaries.
      if (isUserSelection()) {
        sseLog.info(`🎯 Track changed → clearing user selection (was selecting ${state.selection.trackId?.substring(0,8)})`);
        clearSelection('track_change');
      }
      if (inferredTrack && allowSelectionUpdate) {
        setSelection(inferredTrack, 'server');
      }
      if (typeof window.updateRadiusControlsUI === 'function') {
        window.updateRadiusControlsUI();
      }
    } else {
      if (resolutionChanged) {
        clearSelection('resolution_change');
        if (inferredTrack && allowSelectionUpdate) {
          setSelection(inferredTrack, 'server');
        }
        if (typeof window.updateRadiusControlsUI === 'function') {
          window.updateRadiusControlsUI();
        }
      } else if (!isUserSelection() && inferredTrack && allowSelectionUpdate) {
        setSelection(inferredTrack, 'server');
      }
    }

    if (snapshot.explorer) {
      snapshot.explorer.currentTrack = snapshot.currentTrack || snapshot.explorer.currentTrack || null;

      if (state.latestExplorerData && currentTrackId) {
        if (typeof window.clearStaleNextTrack === 'function') {
          window.clearStaleNextTrack(state.latestExplorerData, currentTrackId);
        }
      }

      const shouldSkip = shouldIgnoreExplorerUpdate(state.latestExplorerData, snapshot.explorer);
      if (shouldSkip) {

      } else {
        state.latestExplorerData = snapshot.explorer;
        if (shouldDeferExplorerNext) {
          if (preservedNextTrack) {
            state.latestExplorerData.nextTrack = preservedNextTrack;
          } else if (state.latestExplorerData.nextTrack) {
            delete state.latestExplorerData.nextTrack;
          }
        }
        state.remainingCounts = {};

        // On initial load or track change, preload album covers before rendering
        const isInitialRender = !previousExplorerData || trackChanged;
        const renderCards = () => {
          sseLog.info('🟢 DIAG: SSE handler calling createDimensionCards', { trackId: snapshot.explorer?.currentTrack?.identifier, trackChanged });
          if (typeof window.createDimensionCards === 'function') {
            window.createDimensionCards(state.latestExplorerData);
          }
          state.lastExplorerPayload = cloneExplorerData(snapshot.explorer);
        };

        if (isInitialRender && typeof window.preloadAlbumCovers === 'function') {
          window.preloadAlbumCovers(snapshot.explorer).then(renderCards);
        } else {
          renderCards();
        }
      }
    }

    if ((trackChanged || !previousTrackId) && (connectionHealth.audio.status === 'error' || connectionHealth.audio.status === 'failed')) {
      sseLog.info('🔄 Explorer snapshot received but audio unhealthy; restarting session');
      handleDeadAudioSession();
      return;
    }

    if (snapshot.currentTrack) {
      sseLog.info(`🎵 ${snapshot.currentTrack.title} by ${snapshot.currentTrack.artist}`);
      if (snapshot.driftState) {
        sseLog.info(`🎯 Direction: ${snapshot.driftState.currentDirection}, Step: ${snapshot.driftState.stepCount}`);
      }
      if (typeof window.updateNowPlayingCard === 'function') {
        window.updateNowPlayingCard(snapshot.currentTrack, snapshot.driftState);
      }
    }

    const durationSeconds = snapshot.currentTrack?.duration || snapshot.currentTrack?.length || state.playbackDurationSeconds || 0;
    if (durationSeconds > 0) {
      if (trackChanged) {
        // Track changed - start from 0, let audio.currentTime drive timing
        startProgressAnimationFromPosition(durationSeconds, 0, { resync: false, trackChanged: true, trackId: currentTrackId });
      } else if (state.playbackStartTimestamp) {
        // Ongoing playback - resync using existing local timing, not server's startTime
        startProgressAnimationFromPosition(durationSeconds, 0, { resync: true, trackId: currentTrackId });
      }
    }

    ensureDeckHydratedAfterTrackChange('explorer-snapshot');
  };

  if (simpleBody) {
    fetch('/refresh-sse-simple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simpleBody)
    }).catch(() => {});
  }

  eventSource.onopen = () => {
    sseLog.info('📡 SSE connected');
    connectionHealth.sse.status = 'connected';
    connectionHealth.sse.reconnectAttempts = 0;
    connectionHealth.sse.reconnectDelay = 2000;
    connectionHealth.sse.lastMessage = Date.now();
    updateConnectionHealthUI();

    resetStuckTimer();

    // Eagerly fetch current track — don't wait for the first heartbeat (up to 10s away)
    if (!state.latestCurrentTrack?.identifier) {
      fetch('/current-track').then(r => (r.ok && r.status !== 204) ? r.json() : null).then(async (data) => {
        if (data?.currentTrack && !state.latestCurrentTrack?.identifier) {
          const trackId = data.currentTrack.identifier;
          sseLog.info(`🎵 Eager current-track: ${trackId?.substring(0, 8)}`);

          // Fetch metadata before handling heartbeat so the card renders with title/artist
          try {
            const metaResp = await fetch(`/track/${trackId}/meta`);
            if (metaResp.ok) {
              const metaData = await metaResp.json();
              if (metaData?.track) {
                Object.assign(data.currentTrack, metaData.track);
                if (!state.trackMetadataCache) state.trackMetadataCache = {};
                state.trackMetadataCache[trackId] = metaData.track;
                if (typeof cacheTrackMeta === 'function') cacheTrackMeta(trackId, metaData.track);
              }
            }
          } catch (e) {
            sseLog.warn('🎵 Eager metadata fetch failed:', e?.message || e);
          }

          handleHeartbeat(data);

          // Trigger explorer fetch
          if (trackId && !state.latestExplorerData?.directions) {
            armExplorerSnapshotTimer(trackId, { reason: 'eager-first-track' });
          }
        }
      }).catch((err) => {
        sseLog.error('🎵 Eager current-track failed:', err?.message || err);
      });
    }
  };

  eventSource.onmessage = (event) => {
    connectionHealth.sse.lastMessage = Date.now();
    resetStuckTimer();

    try {
      const raw = JSON.parse(event.data);

      // Normalize explorer sample tracks early (wrap { track } -> track)
      if (raw.explorer && raw.explorer.directions) {
        for (const directionKey of Object.keys(raw.explorer.directions)) {
          const direction = raw.explorer.directions[directionKey];
          if (Array.isArray(direction.sampleTracks)) {
            direction.sampleTracks = direction.sampleTracks.map(entry => entry.track || entry);
          }
          if (direction.oppositeDirection && Array.isArray(direction.oppositeDirection.sampleTracks)) {
            direction.oppositeDirection.sampleTracks = direction.oppositeDirection.sampleTracks.map(entry => entry.track || entry);
          }
        }
      }

      const data = raw;
      sseLog.info('📡 Event:', data.type, data);

      if (data.type === 'error') {
        sseLog.error('📡 SSE reported error payload:', data.message);
        if (audioHealth.isHealthy) {
          eventSource.close();
          if (data.message === 'fingerprint_not_found' || data.message === 'session_not_found') {
            sseLog.info('🔄 SSE session missing; requesting refresh');
            requestSSERefresh({ escalate: false })
              .then((ok) => {
                if (ok) {
                  connectSSE();
                } else {
                  sseLog.warn('⚠️ Session refresh failed; bootstrapping new stream');
                  createNewJourneySession('session_not_found');
                }
              })
              .catch((err) => {
                sseLog.error('❌ Session refresh request failed:', err);
                setTimeout(() => connectSSE(), 2000);
              });
          } else {
            sseLog.info('🔄 SSE error payload received while audio healthy; reconnecting SSE');
            setTimeout(() => connectSSE(), 2000);
          }
        } else {
          sseLog.info('🔄 SSE error payload and audio unhealthy; restarting session');
          eventSource.close();
          handleDeadAudioSession();
        }
        return;
      }

      if (data.type === 'connected') {
        const previousSession = state.sessionId;
        if (data.sessionId) {
          state.sessionId = data.sessionId;
          if (previousSession && previousSession !== data.sessionId) {
            sseLog.warn(`🆔 SSE reported session change ${previousSession} → ${data.sessionId}`);
          } else if (!previousSession) {
            sseLog.info(`🆔 SSE assigned session: ${state.sessionId}`);
          }
        }

      }

      // Ignore events from other sessions (legacy safety)
      if (state.sessionId && data.session && data.session.sessionId && data.session.sessionId !== state.sessionId) {
        sseLog.info(`🚫 Ignoring event from different session: ${data.session.sessionId} (mine: ${state.sessionId})`);
        return;
      }

      if (data.type === 'heartbeat') {
        handleHeartbeat(data);
        return;
      }

      if (data.type === 'explorer_snapshot') {
        // Explorer snapshots are now handled via POST /explorer request/response
        // This SSE event type is deprecated and will be removed from the server
        sseLog.info('📡 Ignoring explorer_snapshot SSE event (use POST /explorer instead)');
        return;
      }

      if (data.type === 'selection_ack') {
        handleSelectionAck(data);
        return;
      }

      if (data.type === 'selection_ready') {
        handleSelectionReady(data);
        return;
      }

      if (data.type === 'selection_failed') {
        handleSelectionFailed(data);
        return;
      }

      if (data.type === 'flow_options') {
        sseLog.info('🌟 Flow options available:', Object.keys(data.flowOptions));
      }

      if (data.type === 'direction_change') {
        sseLog.info(`🔄 Flow changed to: ${data.direction}`);
      }

    } catch (e) {
      sseLog.info('📡 Raw event:', event.data);
    }
  };

  eventSource.onerror = (error) => {
    sseLog.error('❌ SSE error:', error);
    connectionHealth.sse.status = 'reconnecting';
    updateConnectionHealthUI();

    if (audioHealth.handlingRestart) {
      eventSource.close();
      return;
    }

    if (audioHealth.isHealthy) {
      sseLog.info('🔄 SSE died but audio healthy - reconnecting SSE to same session');
      eventSource.close();
      setTimeout(() => {
        connectSSE();
      }, 2000);
    } else {
      sseLog.info('🔄 SSE died and audio unhealthy - full restart needed');
      eventSource.close();
      handleDeadAudioSession();
    }
  };
}

// Expose globally for backward compatibility and console debugging
window.connectSSE = connectSSE;
