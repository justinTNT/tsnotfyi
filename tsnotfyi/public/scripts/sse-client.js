// SSE client - Server-Sent Events connection and message handling
import { state, connectionHealth, audioHealth, PENDING_EXPLORER_FORCE_MS, TRACK_SWITCH_PROGRESS_THRESHOLD, debugLog } from './globals.js';
import { composeEventsEndpoint, syncEventsEndpoint, applyFingerprint, normalizeResolution } from './session-utils.js';
import { requestSSERefresh, createNewJourneySession, scheduleHeartbeat } from './sync-manager.js';
import { armExplorerSnapshotTimer, clearExplorerSnapshotTimer, setDeckStaleFlag, clearPendingExplorerLookahead, forceApplyPendingExplorerSnapshot } from './deck-state.js';
import { exitDangerZoneVisualState, exitCardsDormantState, ensureDeckHydratedAfterTrackChange } from './danger-zone.js';
import { cloneExplorerData, explorerContainsTrack, findTrackInExplorer, shouldIgnoreExplorerUpdate, summarizeExplorerSnapshot } from './explorer-utils.js';
import { startProgressAnimationFromPosition, maybeApplyDeferredNextTrack, getVisualProgressFraction } from './progress-ui.js';
import { updateConnectionHealthUI, handleDeadAudioSession } from './audio-manager.js';
import { popPlaylistHead, playlistHasItems, getPlaylistNext, renderPlaylistTray } from './playlist-tray.js';
import { cancelPackAwayAnimation } from './clock-animation.js';

// Smart SSE connection with health monitoring and reconnection
export function connectSSE() {
  const fingerprint = state.streamFingerprint;
  const eventsUrl = composeEventsEndpoint(fingerprint);
  syncEventsEndpoint(fingerprint);
  state.awaitingSSE = false;

  if (fingerprint) {
    console.log(`🔌 Connecting SSE to fingerprint: ${fingerprint}`);
  } else {
    console.log('🔌 Connecting SSE (awaiting fingerprint from audio stream)');
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
      console.warn('📡 SSE stuck but fingerprint not yet assigned; waiting for audio session');
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
        console.warn('📡 SSE stuck check: forcing reconnect');
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
      console.warn('⚠️ Heartbeat missing currentTrack payload');
      return;
    }

    if (heartbeat.fingerprint && state.streamFingerprint !== heartbeat.fingerprint) {
      applyFingerprint(heartbeat.fingerprint);
    }

    const currentTrack = heartbeat.currentTrack;
    const currentTrackId = currentTrack.identifier || null;
    const previousTrackId = state.latestCurrentTrack?.identifier || null;
    const trackChanged = Boolean(currentTrackId && previousTrackId && currentTrackId !== previousTrackId);

    if (Number.isFinite(currentTrack.durationMs)) {
      state.playbackDurationSeconds = Math.max(currentTrack.durationMs / 1000, 0);
    } else if (Number.isFinite(currentTrack.duration || currentTrack.length)) {
      state.playbackDurationSeconds = currentTrack.duration || currentTrack.length || 0;
    }

    if (currentTrack.startTime) {
      state.playbackStartTimestamp = currentTrack.startTime;
    } else if (Number.isFinite(heartbeat.timing?.elapsedMs)) {
      state.playbackStartTimestamp = Date.now() - heartbeat.timing.elapsedMs;
    }

    // When track changes, clear albumCover to avoid stale cover from previous track
    const baseTrack = trackChanged ? {} : state.latestCurrentTrack;
    state.latestCurrentTrack = {
      ...baseTrack,
      ...currentTrack,
      duration: state.playbackDurationSeconds || currentTrack.duration || currentTrack.length || null,
      length: state.playbackDurationSeconds || currentTrack.duration || currentTrack.length || null
    };
    window.state.latestCurrentTrack = state.latestCurrentTrack;
    state.lastTrackUpdateTs = Date.now();

    if ((trackChanged || (!previousTrackId && currentTrackId)) && currentTrackId) {
      state.pendingSnapshotTrackId = currentTrackId;
        armExplorerSnapshotTimer(currentTrackId, { reason: 'heartbeat-track-change' });

      // Handle playlist queue on track change
      let albumCoverResolved = false;
      if (trackChanged && playlistHasItems()) {
        const queueHead = getPlaylistNext();
        if (queueHead && queueHead.trackId === currentTrackId) {
          // Server played what we expected - advance the queue
          console.log(`🎵 Track change matched queue head - advancing playlist`);

          // Use albumCover from playlist item (server heartbeat doesn't include it)
          if (queueHead.albumCover) {
            state.latestCurrentTrack.albumCover = queueHead.albumCover;
            if (window.state) window.state.latestCurrentTrack = state.latestCurrentTrack;
            albumCoverResolved = true;
          }

          popPlaylistHead();
          renderPlaylistTray();

          // Notify server about new queue head (if any)
          const newHead = getPlaylistNext();
          if (newHead && typeof window.sendNextTrack === 'function') {
            console.log(`🎵 Notifying server of new queue head: ${newHead.trackId.substring(0, 8)}`);
            window.sendNextTrack(newHead.trackId, newHead.directionKey, 'user');
          }
        } else if (queueHead) {
          // Server played something different - force-feed our queue head
          console.log(`🎵 Track change mismatch - server played ${currentTrackId.substring(0, 8)}, queue expected ${queueHead.trackId.substring(0, 8)}`);
          console.log(`🎵 Force-feeding queue head to server: ${queueHead.trackId.substring(0, 8)} (${queueHead.title})`);
          if (typeof window.sendNextTrack === 'function') {
            window.sendNextTrack(queueHead.trackId, queueHead.directionKey, 'user');
          }
        }
      }

      // If albumCover not from playlist, try previousNextTrack (track that was "next" before it started playing)
      if (trackChanged && !albumCoverResolved && !state.latestCurrentTrack.albumCover) {
        if (state.previousNextTrack?.identifier === currentTrackId && state.previousNextTrack?.albumCover) {
          state.latestCurrentTrack.albumCover = state.previousNextTrack.albumCover;
          if (window.state) window.state.latestCurrentTrack = state.latestCurrentTrack;
          console.log(`🎵 Using albumCover from previousNextTrack for ${currentTrackId.substring(0, 8)}`);
        }
      }

      // Add track to session history for explorer exclusions
      if (!state.sessionTrackHistory) {
        state.sessionTrackHistory = [];
      }
      if (!state.sessionTrackHistory.includes(currentTrackId)) {
        state.sessionTrackHistory.push(currentTrackId);
        console.log(`🎵 Added to session history: ${currentTrackId.substring(0, 8)} (${state.sessionTrackHistory.length} total)`);
      }

      // Cancel any in-progress pack-away animation on track change
      cancelPackAwayAnimation();
    }

    const adoptionResult = typeof window.adoptPendingLiveTrackCandidate === 'function'
      ? window.adoptPendingLiveTrackCandidate(state.latestCurrentTrack, heartbeat.driftState || null)
      : { adopted: false, driftState: null };

    if (trackChanged && !adoptionResult.adopted && state.pendingLiveTrackCandidate) {
      const trackId = typeof window.resolveTrackIdentifier === 'function'
        ? window.resolveTrackIdentifier(state.pendingLiveTrackCandidate.track)
        : state.pendingLiveTrackCandidate.track?.identifier;
      console.warn('📌 Clearing stale pending candidate after track change (heartbeat)', {
        pending: trackId,
        playing: state.latestCurrentTrack?.identifier || null
      });
      state.pendingLiveTrackCandidate = null;
      if (typeof window !== 'undefined' && window.state) {
        window.state.pendingLiveTrackCandidate = null;
      }
      if (typeof window.updatePlaylistTrayPreview === 'function') {
        window.updatePlaylistTrayPreview({ immediate: true });
      }
    }

    const durationSeconds = state.playbackDurationSeconds || currentTrack.duration || currentTrack.length || 0;

    // Only set position from server on track changes - let audio.currentTime drive during playback
    if (trackChanged && durationSeconds > 0) {
      let elapsedSeconds = 0;
      if (Number.isFinite(heartbeat.timing?.elapsedMs)) {
        elapsedSeconds = Math.max(heartbeat.timing.elapsedMs / 1000, 0);
      }
      const clampedElapsed = Math.min(elapsedSeconds, durationSeconds);
      startProgressAnimationFromPosition(durationSeconds, clampedElapsed, { resync: false });
    } else if (durationSeconds > 0 && !state.progressAnimation) {
      // Start animation if not running (e.g., first heartbeat after page load)
      const elapsedSeconds = Number.isFinite(heartbeat.timing?.elapsedMs)
        ? Math.max(heartbeat.timing.elapsedMs / 1000, 0)
        : 0;
      startProgressAnimationFromPosition(durationSeconds, Math.min(elapsedSeconds, durationSeconds), { resync: false });
    }

    const nextTrackId = heartbeat.nextTrack?.track?.identifier || heartbeat.nextTrack?.identifier || null;
    if (nextTrackId) {
      state.serverNextTrack = nextTrackId;
      state.serverNextDirection = heartbeat.nextTrack?.direction || heartbeat.nextTrack?.directionKey || null;
      if (!state.manualNextTrackOverride) {
        state.selectedIdentifier = nextTrackId;

        // Update center card with full track details if track changed
        const centerCard = document.querySelector('.dimension-card.next-track');
        if (centerCard && centerCard.dataset.trackMd5 !== nextTrackId) {
          const match = findTrackInExplorer(state.latestExplorerData, nextTrackId);
          if (match?.track && match?.direction && typeof window.updateCardWithTrackDetails === 'function') {
            window.updateCardWithTrackDetails(centerCard, match.track, match.direction, true);
          }
        }

        if (typeof window.updatePlaylistTrayPreview === 'function') {
          window.updatePlaylistTrayPreview();
        }
      }

      if (!state.manualNextTrackOverride && heartbeat.nextTrack?.track) {
        const lockedId = typeof window.resolveTrackIdentifier === 'function'
          ? window.resolveTrackIdentifier(state.pendingLiveTrackCandidate?.track)
          : state.pendingLiveTrackCandidate?.track?.identifier;
        const needsUpdate =
          !lockedId ||
          lockedId !== nextTrackId ||
          !state.pendingLiveTrackCandidate?.driftState?.currentDirection;
        if (needsUpdate && typeof window.recordPendingLiveTrackCandidate === 'function') {
          window.recordPendingLiveTrackCandidate(
            heartbeat.nextTrack.track,
            state.serverNextDirection ? { currentDirection: state.serverNextDirection } : null,
            { source: 'heartbeat-auto', directionKey: state.serverNextDirection }
          );
        }
      }
    }

    const overrideInfo = heartbeat.override || null;
    if (overrideInfo && overrideInfo.identifier) {
      const overrideId = overrideInfo.identifier;
      if (overrideInfo.status === 'pending' || overrideInfo.status === 'prepared' || overrideInfo.status === 'locked') {
        state.manualNextTrackOverride = true;
        state.pendingManualTrackId = overrideId;
        if (!state.selectedIdentifier || state.selectedIdentifier === state.serverNextTrack) {
          state.selectedIdentifier = overrideId;

          // Update center card with full track details
          const centerCard = document.querySelector('.dimension-card.next-track');
          if (centerCard && centerCard.dataset.trackMd5 !== overrideId) {
            const match = findTrackInExplorer(state.latestExplorerData, overrideId);
            if (match?.track && match?.direction && typeof window.updateCardWithTrackDetails === 'function') {
              window.updateCardWithTrackDetails(centerCard, match.track, match.direction, true);
            }
          }
        }
      }
    }

    if (trackChanged && currentTrackId && state.manualNextTrackOverride) {
      if (state.selectedIdentifier && currentTrackId === state.selectedIdentifier) {
        console.log('🎯 Heartbeat: manual override track is now playing; clearing override after confirmation');
        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        state.selectedIdentifier = currentTrackId;
        if (typeof window.updateRadiusControlsUI === 'function') {
          window.updateRadiusControlsUI();
        }
      }
    }

    const driftStateForCard = adoptionResult.driftState || heartbeat.driftState || null;
    if (typeof window.updateNowPlayingCard === 'function') {
      window.updateNowPlayingCard(state.latestCurrentTrack, driftStateForCard);
    }
  };

  const handleSelectionAck = (event) => {
    const trackId = event.trackId || event.track?.identifier || null;
    if (!trackId) {
      return;
    }

    console.log('🛰️ selection_ack', event);

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
    }


    if (typeof window.refreshCardsWithNewSelection === 'function') {
      window.refreshCardsWithNewSelection();
    }
  };

  const handleSelectionReady = (event) => {
    const trackId = event.trackId || null;
    console.log('🛰️ selection_ready', event);

    if (trackId) {
      findTrackInExplorer(state.latestExplorerData, trackId);

      if (state.pendingManualTrackId === trackId) {
        state.manualNextTrackOverride = true;
      }
    }
  };

  const handleSelectionFailed = (event) => {
    console.warn('🛰️ selection_failed', event);
    const failedTrack = event.trackId || null;

    if (!failedTrack || state.pendingManualTrackId === failedTrack) {
      state.manualNextTrackOverride = false;
      state.manualNextDirectionKey = null;
      state.pendingManualTrackId = null;
    }

    requestSSERefresh({ escalate: false });
  };

  const handleExplorerSnapshot = (snapshot, options = {}) => {
    if (!snapshot) {
      return;
    }

    const { forced = false } = options;
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
    const pendingMatchesSnapshot = Boolean(state.pendingSnapshotTrackId && snapshotTrackId && state.pendingSnapshotTrackId === snapshotTrackId);
    const snapshotAheadOfHeartbeat = Boolean(
      snapshotTrackId &&
      previousTrackId &&
      snapshotTrackId !== previousTrackId &&
      !pendingMatchesSnapshot
    );

    if (snapshotAheadOfHeartbeat && !forced) {
      console.log('⏳ Explorer snapshot currentTrack deferred until heartbeat confirms flip', {
        snapshotTrackId,
        liveTrackId: previousTrackId,
        title: snapshot.currentTrack?.title || null
      });
      state.pendingExplorerLookaheadTrackId = snapshotTrackId;
      state.pendingExplorerLookaheadSnapshot = cloneExplorerData(snapshot);
      if (state.pendingExplorerLookaheadTimer) {
        clearTimeout(state.pendingExplorerLookaheadTimer);
      }
      state.pendingExplorerLookaheadTimer = setTimeout(() => {
        console.warn('🧭 Pending explorer snapshot timed out waiting for heartbeat', {
          trackId: state.pendingExplorerLookaheadTrackId || snapshotTrackId
        });
        forceApplyPendingExplorerSnapshot('timeout');
      }, PENDING_EXPLORER_FORCE_MS);
      return;
    } else if (
      state.pendingExplorerLookaheadTrackId &&
      snapshotTrackId &&
      snapshotTrackId === state.pendingExplorerLookaheadTrackId
    ) {
      clearPendingExplorerLookahead({ reason: 'snapshot-match' });
    }

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
      console.log('🟡 DIAG: Track changed!', { from: previousTrackId, to: currentTrackId, hasExplorer: !!snapshot.explorer });
      exitCardsDormantState({ immediate: true });
      if (typeof window.hideNextTrackPreview === 'function') {
        window.hideNextTrackPreview({ immediate: false });
      }
      exitDangerZoneVisualState({ reason: 'snapshot-track-change' });
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
      progressFraction < TRACK_SWITCH_PROGRESS_THRESHOLD &&
      !forced
    ) {
      shouldDeferExplorerNext = true;
      state.pendingExplorerNext = {
        nextTrack: JSON.parse(JSON.stringify(snapshot.explorer.nextTrack)),
        selectionId: explorerNextTrackId,
        directionKey: snapshot.explorer.nextTrack.directionKey || snapshot.explorer.nextTrack.direction || null
      };
    } else if (trackChanged || forced) {
      state.pendingExplorerNext = null;
    }

    const allowSelectionUpdate = !shouldDeferExplorerNext;

    const manualSelectionId = state.manualNextTrackOverride ? state.selectedIdentifier : null;
    if (trackChanged && state.manualNextTrackOverride && manualSelectionId && currentTrackId && currentTrackId !== manualSelectionId) {
      console.warn('🛰️ ACTION override-diverged', {
        manualSelection: manualSelectionId,
        playing: currentTrackId,
        manualDirection: state.manualNextDirectionKey,
        serverSuggestedNext: inferredTrack || null
      });
        scheduleHeartbeat(10000);
    }
    if (trackChanged) {
      if (state.manualNextTrackOverride) {
        const selectionVisible = manualSelectionId && snapshot.explorer &&
          explorerContainsTrack(snapshot.explorer, manualSelectionId);
        if (!selectionVisible) {
          // Selection not visible in new explorer data
        } else {
          // Selection still visible
        }
      } else if (inferredTrack && allowSelectionUpdate) {
        state.selectedIdentifier = inferredTrack;
        if (typeof window.updateRadiusControlsUI === 'function') {
          window.updateRadiusControlsUI();
        }
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

    if (state.manualNextTrackOverride && currentTrackId && state.pendingManualTrackId && currentTrackId === state.pendingManualTrackId) {
      state.manualNextTrackOverride = false;
      state.manualNextDirectionKey = null;
      state.pendingManualTrackId = null;
      state.selectedIdentifier = currentTrackId;
      if (typeof window.updateRadiusControlsUI === 'function') {
        window.updateRadiusControlsUI();
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
        debugLog('deck', '🔁 Skipping redundant explorer update', {
          previousSummary: summarizeExplorerSnapshot(state.latestExplorerData),
          incomingSummary: summarizeExplorerSnapshot(snapshot.explorer)
        });
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
        console.log('🟢 DIAG: SSE handler calling createDimensionCards', { trackId: snapshot.explorer?.currentTrack?.identifier, trackChanged });
        if (typeof window.createDimensionCards === 'function') {
          window.createDimensionCards(state.latestExplorerData);
        }
        state.lastExplorerPayload = cloneExplorerData(snapshot.explorer);
      }
    }

    if ((trackChanged || !previousTrackId) && (connectionHealth.audio.status === 'error' || connectionHealth.audio.status === 'failed')) {
      console.log('🔄 Explorer snapshot received but audio unhealthy; restarting session');
      handleDeadAudioSession();
      return;
    }

    if (snapshot.currentTrack) {
      console.log(`🎵 ${snapshot.currentTrack.title} by ${snapshot.currentTrack.artist}`);
      if (snapshot.driftState) {
        console.log(`🎯 Direction: ${snapshot.driftState.currentDirection}, Step: ${snapshot.driftState.stepCount}`);
      }
      if (typeof window.updateNowPlayingCard === 'function') {
        window.updateNowPlayingCard(snapshot.currentTrack, snapshot.driftState);
      }
    }

    const durationSeconds = snapshot.currentTrack?.duration || snapshot.currentTrack?.length || state.playbackDurationSeconds || 0;
    const startTimeMs = snapshot.currentTrack?.startTime || state.playbackStartTimestamp || null;
    if (durationSeconds > 0 && startTimeMs) {
      const elapsedSeconds = Math.max((Date.now() - startTimeMs) / 1000, 0);
      const clampedElapsed = Math.min(elapsedSeconds, durationSeconds);
      startProgressAnimationFromPosition(durationSeconds, clampedElapsed, { resync: !trackChanged });
    }

    ensureDeckHydratedAfterTrackChange('explorer-snapshot');
  };

  // Expose for forceApplyPendingExplorerSnapshot which is defined outside connectSSE scope
  window.__handleExplorerSnapshot = handleExplorerSnapshot;

  if (simpleBody) {
    fetch('/refresh-sse-simple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simpleBody)
    }).catch(() => {});
  }

  eventSource.onopen = () => {
    console.log('📡 SSE connected');
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
      console.log('📡 Event:', data.type, data);

      if (data.type === 'error') {
        console.error('📡 SSE reported error payload:', data.message);
        if (audioHealth.isHealthy) {
          eventSource.close();
          if (data.message === 'fingerprint_not_found') {
            console.log('🔄 SSE fingerprint missing; requesting refresh');
            requestSSERefresh({ escalate: false })
              .then((ok) => {
                if (ok) {
                  connectSSE();
                } else {
                  console.warn('⚠️ Fingerprint refresh failed; bootstrapping new stream');
                  createNewJourneySession('fingerprint_not_found');
                }
              })
              .catch((err) => {
                console.error('❌ Fingerprint refresh request failed:', err);
                setTimeout(() => connectSSE(), 2000);
              });
          } else {
            console.log('🔄 SSE error payload received while audio healthy; reconnecting SSE');
            setTimeout(() => connectSSE(), 2000);
          }
        } else {
          console.log('🔄 SSE error payload and audio unhealthy; restarting session');
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
            console.warn(`🆔 SSE reported session change ${previousSession} → ${data.sessionId}`);
          } else if (!previousSession) {
            console.log(`🆔 SSE assigned session: ${state.sessionId}`);
          }
        }

        if (data.fingerprint) {
          applyFingerprint(data.fingerprint);
        }
      }

      // Ignore events from other sessions (legacy safety)
      if (state.sessionId && data.session && data.session.sessionId && data.session.sessionId !== state.sessionId) {
        console.log(`🚫 Ignoring event from different session: ${data.session.sessionId} (mine: ${state.sessionId})`);
        return;
      }

      if (state.streamFingerprint && data.fingerprint && data.fingerprint !== state.streamFingerprint) {
        console.log(`🔄 Updating fingerprint from ${state.streamFingerprint} → ${data.fingerprint}`);
        applyFingerprint(data.fingerprint);
      }

      if (data.type === 'heartbeat') {
        handleHeartbeat(data);
        return;
      }

      if (data.type === 'explorer_snapshot') {
        // Explorer snapshots are now handled via POST /explorer request/response
        // This SSE event type is deprecated and will be removed from the server
        console.log('📡 Ignoring explorer_snapshot SSE event (use POST /explorer instead)');
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
        console.log('🌟 Flow options available:', Object.keys(data.flowOptions));
      }

      if (data.type === 'direction_change') {
        console.log(`🔄 Flow changed to: ${data.direction}`);
      }

    } catch (e) {
      console.log('📡 Raw event:', event.data);
    }
  };

  eventSource.onerror = (error) => {
    console.error('❌ SSE error:', error);
    connectionHealth.sse.status = 'reconnecting';
    updateConnectionHealthUI();

    if (audioHealth.handlingRestart) {
      eventSource.close();
      return;
    }

    if (audioHealth.isHealthy) {
      console.log('🔄 SSE died but audio healthy - reconnecting SSE to same session');
      eventSource.close();
      setTimeout(() => {
        connectSSE();
      }, 2000);
    } else {
      console.log('🔄 SSE died and audio unhealthy - full restart needed');
      eventSource.close();
      handleDeadAudioSession();
    }
  };
}

// Expose globally for backward compatibility and console debugging
window.connectSSE = connectSSE;
