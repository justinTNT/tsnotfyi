// SSE client - Server-Sent Events connection and message handling
import { state, connectionHealth, audioHealth, TRACK_SWITCH_PROGRESS_THRESHOLD } from './globals.js';
import { createLogger } from './log.js';
import { composeEventsEndpoint, syncEventsEndpoint, applyFingerprint, normalizeResolution } from './session-utils.js';
import { requestSSERefresh, createNewJourneySession, scheduleHeartbeat } from './sync-manager.js';
import { armExplorerSnapshotTimer, clearExplorerSnapshotTimer, setDeckStaleFlag } from './deck-state.js';
import { exitCardsDormantState, ensureDeckHydratedAfterTrackChange } from './card-state.js';
import { cloneExplorerData, explorerContainsTrack, findTrackInExplorer, shouldIgnoreExplorerUpdate, summarizeExplorerSnapshot } from './explorer-utils.js';
import { startProgressAnimationFromPosition, maybeApplyDeferredNextTrack, getVisualProgressFraction } from './progress-ui.js';
import { updateConnectionHealthUI, handleDeadAudioSession } from './audio-manager.js';
import { popPlaylistHead, playlistHasItems, getPlaylistNext, renderPlaylistTray } from './playlist-tray.js';

const sseLog = createLogger('sse');
const syncLog = createLogger('sync');

// Smart SSE connection with health monitoring and reconnection
export function connectSSE() {
  const fingerprint = state.streamFingerprint;
  const eventsUrl = composeEventsEndpoint(fingerprint);
  syncEventsEndpoint(fingerprint);
  state.awaitingSSE = false;

  if (fingerprint) {
    sseLog.info(`🔌 Connecting SSE to fingerprint: ${fingerprint}`);
  } else {
    sseLog.info('🔌 Connecting SSE (awaiting fingerprint from audio stream)');
  }

  connectionHealth.sse.status = 'connecting';
  updateConnectionHealthUI();

  // Close existing connection if any
  if (connectionHealth.currentEventSource) {
    connectionHealth.currentEventSource.close();
  }

  const eventSource = new EventSource(eventsUrl);
  connectionHealth.currentEventSource = eventSource;

  const handleSseStuck = async () => {
    if (!state.streamFingerprint) {
      sseLog.warn('📡 SSE stuck but fingerprint not yet assigned; waiting for audio session');
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

  const simpleBody = state.streamFingerprint
    ? { fingerprint: state.streamFingerprint, sessionId: state.sessionId }
    : null;

  const handleHeartbeat = (heartbeat) => {
    if (!heartbeat || !heartbeat.currentTrack) {
      syncLog.warn('⚠️ Heartbeat missing currentTrack payload');
      return;
    }

    if (heartbeat.fingerprint && state.streamFingerprint !== heartbeat.fingerprint) {
      applyFingerprint(heartbeat.fingerprint);
    }

    const currentTrack = heartbeat.currentTrack;
    const currentTrackId = currentTrack.identifier || null;
    const previousTrackId = state.latestCurrentTrack?.identifier || null;
    const trackChanged = Boolean(currentTrackId && previousTrackId && currentTrackId !== previousTrackId);

    // Compute duration and start time
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

    const newTrackState = {
      ...state.latestCurrentTrack,
      ...currentTrack,
      duration: newDurationSeconds || currentTrack.duration || currentTrack.length || null,
      length: newDurationSeconds || currentTrack.duration || currentTrack.length || null
    };

    // === STEADY-STATE: apply state for non-track-change heartbeats ===
    // Track changes are handled by the sentinel callback in page.js.
    // Heartbeats that report a different track are ignored for presentation —
    // the sentinel will fire at the exact audio boundary.

    if (!trackChanged) {
      state.playbackDurationSeconds = newDurationSeconds;
      if (newStartTimestamp) state.playbackStartTimestamp = newStartTimestamp;
      state.latestCurrentTrack = newTrackState;
      window.state.latestCurrentTrack = state.latestCurrentTrack;
      state.lastTrackUpdateTs = Date.now();
    }

    // === IMMEDIATE BOOKKEEPING on track change (no visual effect) ===
    // Playlist pop is deferred to the sentinel handler (page.js onSentinel) so the
    // cover stays in the tray until it appears on the card. But if the sentinel
    // doesn't handle it within a few seconds, pop here as a fallback.
    if (trackChanged && currentTrackId) {
      // Stash the heartbeat's track data for deferred fallback.
      // The sentinel handler is the primary path for card update + tray pop.
      // If it doesn't fire within 8s, this fallback promotes the track atomically.
      if (state._deferredPlaylistPopTimer) clearTimeout(state._deferredPlaylistPopTimer);
      const fallbackTrackState = newTrackState;
      const fallbackDriftState = heartbeat.driftState || heartbeat.drift || null;
      const fallbackDurationSeconds = newDurationSeconds;
      const fallbackStartTimestamp = newStartTimestamp;
      state._deferredPlaylistPopTimer = setTimeout(() => {
        state._deferredPlaylistPopTimer = null;
        // Only act if the current card still shows the OLD track
        if (state.latestCurrentTrack?.identifier === currentTrackId) return;
        syncLog.info(`🎵 Heartbeat fallback: sentinel didn't handle track change to ${currentTrackId.substring(0, 8)} — promoting now`);

        // Update state + card (same as sentinel would)
        state.playbackDurationSeconds = fallbackDurationSeconds;
        if (fallbackStartTimestamp) state.playbackStartTimestamp = fallbackStartTimestamp;
        state.latestCurrentTrack = fallbackTrackState;
        window.state.latestCurrentTrack = fallbackTrackState;
        state.lastTrackUpdateTs = Date.now();
        state.currentTrackDirection = heartbeat.currentTrackDirection || null;

        if (typeof window.updateNowPlayingCard === 'function') {
          window.updateNowPlayingCard(fallbackTrackState, fallbackDriftState);
        }

        // Pop tray atomically with card update
        if (playlistHasItems()) {
          const head = getPlaylistNext();
          if (head && head.trackId === currentTrackId) {
            syncLog.info(`🎵 Atomic tray→card (heartbeat fallback): popping ${currentTrackId.substring(0, 8)} from tray (card just painted)`);
            popPlaylistHead();
            renderPlaylistTray();
            const newHead = getPlaylistNext();
            if (newHead && typeof window.sendNextTrack === 'function') {
              window.sendNextTrack(newHead.trackId, newHead.directionKey, 'user');
            }
          }
        }

        if (fallbackDurationSeconds > 0) {
          startProgressAnimationFromPosition(fallbackDurationSeconds, 0, { resync: false, trackChanged: true, trackId: currentTrackId });
        }

        armExplorerSnapshotTimer(currentTrackId, { reason: 'heartbeat-fallback-track-change' });
      }, 8000);

      if (!state.sessionTrackHistory) state.sessionTrackHistory = [];
      if (!state.sessionTrackHistory.includes(currentTrackId)) {
        state.sessionTrackHistory.push(currentTrackId);
      }
    }

    // === FIRST-TRACK DETECTION (no sentinel for the very first track) ===
    const isFirstTrack = !previousTrackId && currentTrackId;
    if (isFirstTrack) {
      state.playbackDurationSeconds = newDurationSeconds;
      if (newStartTimestamp) state.playbackStartTimestamp = newStartTimestamp;
      state.latestCurrentTrack = newTrackState;
      window.state.latestCurrentTrack = state.latestCurrentTrack;
      state.lastTrackUpdateTs = Date.now();

      state.pendingSnapshotTrackId = currentTrackId;
      armExplorerSnapshotTimer(currentTrackId, { reason: 'heartbeat-first-track' });

      if (!state.sessionTrackHistory) state.sessionTrackHistory = [];
      if (!state.sessionTrackHistory.includes(currentTrackId)) {
        state.sessionTrackHistory.push(currentTrackId);
        sseLog.info(`🎵 Added to session history: ${currentTrackId.substring(0, 8)} (${state.sessionTrackHistory.length} total)`);
      }

      state.currentTrackDirection = heartbeat.currentTrackDirection || null;

      state.awaitingInitialExplorer = true;
      sseLog.info(`🎵 First track detected — deferring card presentation until explorer data arrives`);

      const durationSeconds = newDurationSeconds || currentTrack.duration || currentTrack.length || 0;
      if (durationSeconds > 0 && !state.progressAnimation) {
        startProgressAnimationFromPosition(durationSeconds, 0, { resync: false, trackId: currentTrackId });
      }
    }

    // === NEXT-TRACK / OVERRIDE STATE (kept — not track-change logic) ===

    const nextTrackId = heartbeat.nextTrack?.track?.identifier || heartbeat.nextTrack?.identifier || null;
    const nextTrackValid = nextTrackId && nextTrackId !== currentTrackId;
    if (nextTrackValid) {
      state.serverNextTrack = nextTrackId;
      state.serverNextDirection = heartbeat.nextTrack?.direction || heartbeat.nextTrack?.directionKey || null;
      if (!state.manualNextTrackOverride) {
        const alreadySelected = state.selectedIdentifier === nextTrackId;
        state.selectedIdentifier = nextTrackId;

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
        state.manualNextTrackOverride = true;
        state.pendingManualTrackId = overrideId;
        if (!state.selectedIdentifier || state.selectedIdentifier === state.serverNextTrack) {
          const alreadySelected = state.selectedIdentifier === overrideId;
          state.selectedIdentifier = overrideId;

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

    // === STEADY-STATE PROGRESS RESYNC ===

    if (!trackChanged && !isFirstTrack) {
      const durationSeconds = newDurationSeconds || currentTrack.duration || currentTrack.length || 0;
      const driftStateForCard = heartbeat.driftState || heartbeat.drift || null;

      if (typeof window.updateNowPlayingCard === 'function') {
        window.updateNowPlayingCard(state.latestCurrentTrack, driftStateForCard);
      }
      if (durationSeconds > 0 && !state.progressAnimation) {
        startProgressAnimationFromPosition(durationSeconds, 0, { resync: false, trackId: currentTrackId });
      }
    }
  };

  const handleSelectionAck = (event) => {
    const trackId = event.trackId || event.track?.identifier || null;
    if (!trackId) {
      return;
    }

    sseLog.info('🛰️ selection_ack', event);

    state.manualNextTrackOverride = true;
    state.pendingManualTrackId = trackId;
    if (event.direction) {
      state.manualNextDirectionKey = event.direction;
    }
    state.selectedIdentifier = trackId;

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
    } else if (centerCard) {
      // Track not in explorer data - just update the trackMd5 so state stays consistent
      sseLog.info(`🛰️ selection_ack: track ${trackId.substring(0,8)} not in explorer, updating card dataset only`);
      centerCard.dataset.trackMd5 = trackId;
    }
  };

  const handleSelectionReady = (event) => {
    const trackId = event.trackId || null;
    sseLog.info('🛰️ selection_ready', event);

    if (trackId) {
      findTrackInExplorer(state.latestExplorerData, trackId);

      if (state.pendingManualTrackId === trackId) {
        state.manualNextTrackOverride = true;
      }
    }
  };

  const handleSelectionFailed = (event) => {
    sseLog.warn('🛰️ selection_failed', event);
    const failedTrack = event.trackId || null;

    if (!failedTrack || state.pendingManualTrackId === failedTrack) {
      state.manualNextTrackOverride = false;
      state.manualNextDirectionKey = null;
      state.pendingManualTrackId = null;
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

    if (snapshot.fingerprint && state.streamFingerprint !== snapshot.fingerprint) {
      applyFingerprint(snapshot.fingerprint);
    }

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
      !state.manualNextTrackOverride &&
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

    const manualSelectionId = state.manualNextTrackOverride ? state.selectedIdentifier : null;
    if (trackChanged && state.manualNextTrackOverride && manualSelectionId && currentTrackId && currentTrackId !== manualSelectionId) {
      sseLog.warn('🛰️ ACTION override-diverged', {
        manualSelection: manualSelectionId,
        playing: currentTrackId,
        manualDirection: state.manualNextDirectionKey,
        serverSuggestedNext: inferredTrack || null
      });
        scheduleHeartbeat(10000);
    }
    if (trackChanged) {
      // Track changed — always clear manual override. Its purpose is to protect
      // user selections *during* a track, not to persist across track boundaries.
      if (state.manualNextTrackOverride) {
        sseLog.info(`🎯 Track changed → clearing manualNextTrackOverride (was selecting ${state.selectedIdentifier?.substring(0,8)})`);
        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
      }
      if (inferredTrack && allowSelectionUpdate) {
        state.selectedIdentifier = inferredTrack;
      }
      if (typeof window.updateRadiusControlsUI === 'function') {
        window.updateRadiusControlsUI();
      }
    } else {
      if (resolutionChanged) {
        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        if (inferredTrack && allowSelectionUpdate) {
          state.selectedIdentifier = inferredTrack;
        }
        if (typeof window.updateRadiusControlsUI === 'function') {
          window.updateRadiusControlsUI();
        }
      } else if (!state.manualNextTrackOverride && inferredTrack && allowSelectionUpdate) {
        state.selectedIdentifier = inferredTrack;
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
          if (data.message === 'fingerprint_not_found') {
            sseLog.info('🔄 SSE fingerprint missing; requesting refresh');
            requestSSERefresh({ escalate: false })
              .then((ok) => {
                if (ok) {
                  connectSSE();
                } else {
                  sseLog.warn('⚠️ Fingerprint refresh failed; bootstrapping new stream');
                  createNewJourneySession('fingerprint_not_found');
                }
              })
              .catch((err) => {
                sseLog.error('❌ Fingerprint refresh request failed:', err);
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

        if (data.fingerprint) {
          applyFingerprint(data.fingerprint);
        }
      }

      // Ignore events from other sessions (legacy safety)
      if (state.sessionId && data.session && data.session.sessionId && data.session.sessionId !== state.sessionId) {
        sseLog.info(`🚫 Ignoring event from different session: ${data.session.sessionId} (mine: ${state.sessionId})`);
        return;
      }

      if (state.streamFingerprint && data.fingerprint && data.fingerprint !== state.streamFingerprint) {
        sseLog.info(`🔄 Updating fingerprint from ${state.streamFingerprint} → ${data.fingerprint}`);
        applyFingerprint(data.fingerprint);
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
