// Audio Manager - handles audio streaming, health monitoring, and recovery
// Dependencies: globals.js (state, elements, connectionHealth, audioHealth, constants)

import {
  state,
  elements,
  connectionHealth,
  audioHealth,
  debugLog,
  AUDIO_STARTUP_GRACE_MS,
  CONNECTION_QUARANTINE_BASE_MS,
  CONNECTION_QUARANTINE_MAX_MS,
  MAX_PLAY_RETRY_ATTEMPTS,
  PLAY_RETRY_DELAY_MS,
  AUDIO_STALL_REBUILD_WINDOW_MS,
  AUDIO_STALL_REBUILD_THRESHOLD,
  AUDIO_DEAD_REBUILD_WINDOW_MS,
  AUDIO_DEAD_REBUILD_THRESHOLD
} from './globals.js';

// Callbacks to be set by page.js - allows audio-manager to trigger page-level actions
const audioCallbacks = {
  connectSSE: null,
  maybeApplyPendingTrackUpdate: null,
  startProgressAnimationFromPosition: null,
  clearPendingProgressStart: null,
  verifyExistingSessionOrRestart: null,
  createNewJourneySession: null,
  clearFingerprint: null,
  composeStreamEndpoint: null,
  fullResync: null
};

export function setAudioCallbacks(callbacks) {
  Object.assign(audioCallbacks, callbacks);
}

// ====== Connection Health UI ======

export function updateConnectionHealthUI() {
  const healthIndicator = document.getElementById('connectionHealth');
  const sseStatus = document.getElementById('sseStatus');
  const audioStatusEl = document.getElementById('audioStatus');

  if (!healthIndicator) return;

  if (sseStatus) sseStatus.textContent = connectionHealth.sse.status;
  if (audioStatusEl) audioStatusEl.textContent = connectionHealth.audio.status;

  const sseOk = connectionHealth.sse.status === 'connected';
  const audioOk = connectionHealth.audio.status === 'connected';

  healthIndicator.classList.remove('healthy', 'degraded', 'error');

  if (sseOk && audioOk) {
    healthIndicator.classList.add('healthy');
  } else if (sseOk || audioOk) {
    healthIndicator.classList.add('degraded');
  } else {
    healthIndicator.classList.add('error');
  }
}

// ====== Audio Diagnostics ======

export function logAudioDiagnostics(label, extra = {}) {
  const audioEl = elements.audio;
  if (!audioEl) {
    console.warn('🎧 Audio diagnostics unavailable', {
      label,
      reason: 'no-audio-element',
      ...extra
    });
    return;
  }
  const rawCurrentTime = Number(audioEl.currentTime);
  const rawDuration = Number(audioEl.duration);
  let bufferedSummary = null;
  if (audioEl.buffered && audioEl.buffered.length > 0) {
    try {
      const lastIndex = audioEl.buffered.length - 1;
      bufferedSummary = {
        start: Number(audioEl.buffered.start(lastIndex).toFixed(3)),
        end: Number(audioEl.buffered.end(lastIndex).toFixed(3)),
        length: audioEl.buffered.length
      };
    } catch (bufferErr) {
      bufferedSummary = { error: bufferErr?.message || bufferErr };
    }
  }
  console.log('🎧 Audio diagnostics', {
    label,
    paused: audioEl.paused,
    readyState: audioEl.readyState,
    networkState: audioEl.networkState,
    playbackRate: audioEl.playbackRate,
    currentTime: Number.isFinite(rawCurrentTime) ? Number(rawCurrentTime.toFixed(3)) : null,
    duration: Number.isFinite(rawDuration) ? Number(rawDuration.toFixed(3)) : null,
    currentSrc: audioEl.currentSrc || audioEl.src || null,
    audioTrackStartClock: Number.isFinite(state.audioTrackStartClock) ? Number(state.audioTrackStartClock.toFixed(3)) : state.audioTrackStartClock,
    playbackStartTimestamp: state.playbackStartTimestamp,
    latestTrackId: state.latestCurrentTrack?.identifier || null,
    serverNextTrack: state.serverNextTrack || null,
    buffered: bufferedSummary,
    audioHealth: {
      isHealthy: audioHealth.isHealthy,
      lastTimeUpdate: audioHealth.lastTimeUpdate,
      bufferingStarted: audioHealth.bufferingStarted
    },
    ...extra
  });
}

// ====== Play Retry Management ======

export function clearPlayRetryTimer() {
  if (state.playRetryTimer) {
    clearTimeout(state.playRetryTimer);
    state.playRetryTimer = null;
  }
  state.playRetryAttempts = 0;
}

export function schedulePlayRetry(reason = 'unknown', { delay = PLAY_RETRY_DELAY_MS } = {}) {
  if (state.playRetryAttempts >= MAX_PLAY_RETRY_ATTEMPTS) {
    console.error('🎵 Play retry exhausted', { reason, attempts: state.playRetryAttempts });
    recordAudioInstability('dead');
    connectionHealth.audio.status = 'error';
    updateConnectionHealthUI();
    return;
  }

  if (state.playRetryTimer) {
    clearTimeout(state.playRetryTimer);
  }

  state.playRetryAttempts += 1;
  const attemptNumber = state.playRetryAttempts;
  state.playRetryTimer = setTimeout(() => {
    state.playRetryTimer = null;
    console.log('🎵 Retrying audio play', { reason, attempt: attemptNumber });
    playAudioElement('retry', { allowRetry: attemptNumber < MAX_PLAY_RETRY_ATTEMPTS });
  }, delay);
}

// ====== Play Audio ======

export function playAudioElement(reason = 'unknown', options = {}) {
  const { allowRetry = true } = options;
  try {
    return elements.audio.play()
      .then(() => {
        connectionHealth.audio.status = 'connected';
        connectionHealth.audio.reconnectAttempts = 0;
        connectionHealth.audio.reconnectDelay = 2000;
        updateConnectionHealthUI();
        clearPlayRetryTimer();
        return true;
      })
      .catch(err => {
        console.error(`🎵 Play failed (${reason}):`, err);
        console.error('🎵 Audio state when play failed:', {
          error: elements.audio.error,
          networkState: elements.audio.networkState,
          readyState: elements.audio.readyState,
          src: elements.audio.src
        });
        connectionHealth.audio.status = allowRetry ? 'connecting' : 'error';
        updateConnectionHealthUI();
        if (allowRetry) {
          schedulePlayRetry(reason);
        }
        if (!connectionHealth.currentEventSource && audioCallbacks.connectSSE) {
          audioCallbacks.connectSSE();
        }
        return false;
      });
  } catch (err) {
    console.error(`🎵 Play threw (${reason}):`, err);
    connectionHealth.audio.status = allowRetry ? 'connecting' : 'error';
    updateConnectionHealthUI();
    if (allowRetry) {
      schedulePlayRetry(reason);
    }
    if (!connectionHealth.currentEventSource && audioCallbacks.connectSSE) {
      audioCallbacks.connectSSE();
    }
    return Promise.resolve(false);
  }
}

// ====== Audio Load State ======

export function markAudioLoadPending(url, reason = 'initial') {
  state.audioLoadPending = true;
  state.audioLoadStartedAt = Date.now();
  state.audioLoadReason = reason || null;
  state.audioLoadUrl = url || null;
  debugLog('timing', 'Marked audio load pending', {
    url,
    reason,
    startedAt: state.audioLoadStartedAt
  });
}

export function clearAudioLoadPending(status = 'completed') {
  if (!state.audioLoadPending) {
    return;
  }
  const elapsed = Date.now() - (state.audioLoadStartedAt || Date.now());
  debugLog('timing', 'Clearing audio load pending', {
    status,
    elapsedMs: elapsed,
    reason: state.audioLoadReason,
    url: state.audioLoadUrl
  });
  state.audioLoadPending = false;
  state.audioLoadStartedAt = 0;
  state.audioLoadReason = null;
  state.audioLoadUrl = null;
  if (audioCallbacks.maybeApplyPendingTrackUpdate) {
    audioCallbacks.maybeApplyPendingTrackUpdate('audio-load-clear');
  }
}

// ====== Startup Grace Period ======

export function extendAudioStartupGrace(reason = 'startup', durationMs = AUDIO_STARTUP_GRACE_MS) {
  if (state.hasSuccessfulAudioStart) {
    return;
  }
  const now = Date.now();
  const target = now + Math.max(durationMs, 0);
  if (target <= (state.audioStartupGraceUntil || 0)) {
    return;
  }
  state.audioStartupGraceUntil = target;
  debugLog('timing', 'Audio startup grace extended', {
    reason,
    remainingMs: target - now
  });
}

export function isWithinAudioStartupGrace() {
  return !state.hasSuccessfulAudioStart
    && state.audioStartupGraceUntil
    && Date.now() < state.audioStartupGraceUntil;
}

export function clearAudioStartupGrace() {
  state.audioStartupGraceUntil = 0;
}

// ====== Connection Quarantine ======

export function enterConnectionQuarantine(reason = 'network', minDurationMs = CONNECTION_QUARANTINE_BASE_MS) {
  const baseDelay = Math.max(state.connectionQuarantineBackoffMs || CONNECTION_QUARANTINE_BASE_MS, minDurationMs);
  const duration = Math.min(baseDelay, CONNECTION_QUARANTINE_MAX_MS);
  const until = Date.now() + duration;
  if (until > (state.connectionQuarantineUntil || 0)) {
    state.connectionQuarantineUntil = until;
    state.connectionQuarantineReason = reason;
    state.connectionQuarantineBackoffMs = Math.min(duration * 1.5, CONNECTION_QUARANTINE_MAX_MS);
    console.warn(`🛑 Connection quarantine engaged (${reason}) for ${Math.round(duration / 1000)}s`);
  }
  return state.connectionQuarantineUntil;
}

export function isConnectionQuarantined() {
  return Boolean(state.connectionQuarantineUntil && Date.now() < state.connectionQuarantineUntil);
}

export function resetConnectionQuarantine(context = 'unknown') {
  if (!state.connectionQuarantineUntil && !state.connectionQuarantineReason) {
    state.connectionQuarantineBackoffMs = CONNECTION_QUARANTINE_BASE_MS;
    return;
  }
  state.connectionQuarantineUntil = 0;
  state.connectionQuarantineReason = null;
  state.connectionQuarantineBackoffMs = CONNECTION_QUARANTINE_BASE_MS;
  console.log(`✅ Connection quarantine cleared (${context})`);
}

// ====== Connect Audio Stream ======

export function connectAudioStream(streamUrl, { forceFallback = false, reason = 'initial' } = {}) {
  if (!streamUrl) {
    console.warn('connectAudioStream called without streamUrl');
    return false;
  }

  state.streamUrl = streamUrl;

  if (!forceFallback && state.useMediaSource && state.streamController) {
    try {
      state.streamController.start(streamUrl);
      markAudioLoadPending(streamUrl, reason);
      return true;
    } catch (err) {
      console.warn(`🎧 MediaSource start failed (${reason}); falling back`, err);
      return connectAudioStream(streamUrl, { forceFallback: true, reason: `${reason}_fallback` });
    }
  }

  const activeLoadAge = state.audioLoadPending ? Date.now() - (state.audioLoadStartedAt || 0) : null;
  if (state.audioLoadPending && !forceFallback && activeLoadAge !== null && activeLoadAge < 5000) {
    console.warn('🎵 connectAudioStream skipped: load already pending', {
      ageMs: activeLoadAge,
      reason,
      pendingReason: state.audioLoadReason
    });
    return false;
  }

  if (state.streamController) {
    try {
      state.streamController.stop();
    } catch (err) {
      console.warn('🎧 MediaSource stop failed during fallback:', err);
    }
  }

  state.streamController = null;
  state.useMediaSource = false;

  try {
    elements.audio.pause();
  } catch (pauseErr) {
    debugLog('timing', 'Audio pause before reload failed', pauseErr);
  }
  elements.audio.removeAttribute('src');
  elements.audio.load();

  clearPlayRetryTimer();
  elements.audio.src = streamUrl;
  elements.audio.load();
  markAudioLoadPending(streamUrl, reason);
  if (!state.hasSuccessfulAudioStart) {
    extendAudioStartupGrace(reason);
  }
  return false;
}

// ====== MediaSource Controller ======

export function initializeMediaStreamController() {
  if (!state.useMediaSource) {
    return;
  }
  const ControllerCtor = window.MediaStreamController;
  if (typeof ControllerCtor !== 'function') {
    state.useMediaSource = false;
    return;
  }

  const streamLogger = (event) => {
    if (!event) return;
    const level = event.level || 'info';
    if (level === 'error') {
      console.error('🎧 MSE error:', event.message, event.error || event);
    } else if (level === 'warn') {
      console.warn('🎧 MSE warn:', event.message, event.error || event);
    }
  };

  try {
    state.streamController = new ControllerCtor(elements.audio, {
      log: streamLogger,
      onError: (err) => {
        console.warn('🎧 MediaSource streaming error; falling back to direct audio', err);
        connectionHealth.audio.status = 'connecting';
        updateConnectionHealthUI();
        audioHealth.isHealthy = false;
        audioHealth.lastTimeUpdate = null;
        audioHealth.bufferingStarted = Date.now();
        startAudioHealthMonitoring();
        state.awaitingSSE = true;
        connectAudioStream(state.streamUrl, { forceFallback: true, reason: 'mse-error' });
        playAudioElement('mse-fallback');
      }
    });
  } catch (err) {
    console.warn('🎧 Failed to initialize MediaSource controller; using direct audio element', err);
    state.streamController = null;
    state.useMediaSource = false;
  }
}

// ====== Audio Instability Tracking ======

export function recordAudioInstability(kind) {
  const now = Date.now();
  const isStall = kind === 'stall';
  const windowMs = isStall ? AUDIO_STALL_REBUILD_WINDOW_MS : AUDIO_DEAD_REBUILD_WINDOW_MS;
  const threshold = isStall ? AUDIO_STALL_REBUILD_THRESHOLD : AUDIO_DEAD_REBUILD_THRESHOLD;
  const storeKey = isStall ? 'audioStallHistory' : 'audioDeadHistory';
  const store = Array.isArray(state[storeKey]) ? state[storeKey] : (state[storeKey] = []);
  store.push(now);
  while (store.length && now - store[0] > windowMs) {
    store.shift();
  }
  if (store.length >= threshold) {
    store.length = 0;
    console.warn(`🔁 Auto audio rebuild triggered (${kind} x${threshold} in ${Math.round(windowMs / 1000)}s)`);
    rebuildAudioElement(`auto-${kind}`);
    return true;
  }
  return false;
}

// ====== Audio Session Recovery ======

async function recoverAudioSession(reason = 'unknown') {
  try {
    if (audioCallbacks.verifyExistingSessionOrRestart) {
      const rebindOk = await audioCallbacks.verifyExistingSessionOrRestart(`audio_dead_${reason}`, { escalate: false });
      if (rebindOk) {
        return true;
      }
    }
  } catch (err) {
    console.error('❌ Audio recovery via session rebind failed:', err);
  }

  try {
    if (audioCallbacks.createNewJourneySession) {
      await audioCallbacks.createNewJourneySession(`audio_dead_${reason}`);
      return true;
    }
  } catch (err) {
    console.error('❌ Audio recovery via new session failed:', err);
  }
  return false;
}

export function handleDeadAudioSession(reason = 'unknown') {
  if (audioHealth.handlingRestart) {
    return;
  }

  const now = Date.now();
  if (isWithinAudioStartupGrace()) {
    const delay = Math.max(1000, state.audioStartupGraceUntil - now);
    console.warn(`⏳ Audio restart suppressed (${Math.round(delay / 1000)}s of startup grace remaining)`);
    if (!audioHealth.pendingGraceTimer) {
      audioHealth.pendingGraceTimer = setTimeout(() => {
        audioHealth.pendingGraceTimer = null;
        handleDeadAudioSession(reason);
      }, delay);
    }
    return;
  }

  if (isConnectionQuarantined()) {
    const delay = Math.max(1000, state.connectionQuarantineUntil - now);
    console.warn(`🛑 Connection quarantined (${state.connectionQuarantineReason || 'unknown'}); retrying audio restart in ${Math.round(delay / 1000)}s`);
    if (!audioHealth.pendingQuarantineTimer) {
      audioHealth.pendingQuarantineTimer = setTimeout(() => {
        audioHealth.pendingQuarantineTimer = null;
        handleDeadAudioSession(reason);
      }, delay);
    }
    return;
  }

  const sseOffline = connectionHealth.sse.status !== 'connected' && !connectionHealth.currentEventSource;
  const audioOffline = connectionHealth.audio.status === 'error' || connectionHealth.audio.status === 'connecting';
  if (sseOffline && audioOffline) {
    const until = enterConnectionQuarantine('sse-offline');
    const delay = Math.max(1000, until - now);
    if (!audioHealth.pendingQuarantineTimer) {
      audioHealth.pendingQuarantineTimer = setTimeout(() => {
        audioHealth.pendingQuarantineTimer = null;
        handleDeadAudioSession(reason);
      }, delay);
    }
    return;
  }

  if (audioHealth.pendingGraceTimer) {
    clearTimeout(audioHealth.pendingGraceTimer);
    audioHealth.pendingGraceTimer = null;
  }
  if (audioHealth.pendingQuarantineTimer) {
    clearTimeout(audioHealth.pendingQuarantineTimer);
    audioHealth.pendingQuarantineTimer = null;
  }

  recordAudioInstability('dead');

  console.error('💀 Audio session is dead - restarting application');
  audioHealth.handlingRestart = true;
  audioHealth.isHealthy = false;
  if (audioHealth.checkInterval) {
    clearInterval(audioHealth.checkInterval);
    audioHealth.checkInterval = null;
  }
  audioHealth.lastTimeUpdate = null;
  audioHealth.bufferingStarted = null;
  clearPlayRetryTimer();

  connectionHealth.audio.status = 'error';
  updateConnectionHealthUI();

  if (state.streamController) {
    try {
      state.streamController.stop();
    } catch (err) {
      console.warn('⚠️ Failed to stop media stream controller during restart:', err);
    }
  }

  try {
    elements.audio.pause();
  } catch (err) {
    console.warn('⚠️ Failed to pause audio during restart:', err);
  }
  clearAudioLoadPending('dead-session');

  state.sessionId = null;
  if (audioCallbacks.clearFingerprint) {
    audioCallbacks.clearFingerprint({ reason: 'audio_restart' });
  }
  state.awaitingSSE = false;

  if (connectionHealth.currentEventSource) {
    try {
      connectionHealth.currentEventSource.close();
    } catch (err) {
      console.warn('⚠️ Failed to close SSE during restart:', err);
    }
    connectionHealth.currentEventSource = null;
  }

  (async () => {
    const recovered = await recoverAudioSession(reason);
    audioHealth.handlingRestart = false;

    if (!recovered) {
      console.error('❌ Audio recovery failed; reloading page as last resort');
      window.location.reload();
      return;
    }

    console.log('✅ Audio session recovery initiated; monitoring stream health');
    state.awaitingSSE = true;
    startAudioHealthMonitoring();
    if (audioCallbacks.connectSSE) {
      audioCallbacks.connectSSE();
    }
    if (elements.audio) {
      try {
        playAudioElement('audio-recovery');
      } catch (err) {
        console.warn('⚠️ Failed to resume audio playback after recovery:', err);
      }
    }
  })();
}

// ====== Audio Health Monitoring ======

export function startAudioHealthMonitoring() {
  if (audioHealth.checkInterval) {
    clearInterval(audioHealth.checkInterval);
  }

  audioHealth.lastTimeUpdate = null;
  audioHealth.bufferingStarted = null;
  audioHealth.isHealthy = false;
  audioHealth.lastObservedTime = Number(elements.audio.currentTime) || 0;

  audioHealth.checkInterval = setInterval(() => {
    if (audioHealth.handlingRestart) {
      return;
    }

    const currentTime = Number(elements.audio.currentTime);
    if (Number.isFinite(currentTime)) {
      if (Math.abs(currentTime - audioHealth.lastObservedTime) > 0.05) {
        audioHealth.lastObservedTime = currentTime;
        audioHealth.lastTimeUpdate = Date.now();
        audioHealth.bufferingStarted = null;
        audioHealth.isHealthy = true;
        connectionHealth.audio.status = 'connected';
        updateConnectionHealthUI();
      }
    }

    if (!audioHealth.lastTimeUpdate) {
      return;
    }

    const now = Date.now();
    const timeSinceUpdate = now - audioHealth.lastTimeUpdate;
    const isBuffering = audioHealth.bufferingStarted !== null;
    const bufferingDuration = isBuffering ? (now - audioHealth.bufferingStarted) : 0;

    if (timeSinceUpdate > 12000) {
      console.error(`❌ Audio session dead: no timeupdate for ${(timeSinceUpdate / 1000).toFixed(1)}s`);
      handleDeadAudioSession();
      return;
    }

    if (bufferingDuration > 8000) {
      console.warn(`⚠️ Audio struggling: buffering for ${(bufferingDuration / 1000).toFixed(1)}s`);
      connectionHealth.audio.status = 'degraded';
      updateConnectionHealthUI();
      return;
    }

    if (audioHealth.isHealthy && connectionHealth.audio.status !== 'connected') {
      connectionHealth.audio.status = 'connected';
      updateConnectionHealthUI();
    }
  }, 2000);
}

// ====== Audio Event Listeners ======

export function attachBaseAudioEventListeners(audioEl = elements.audio) {
  if (!audioEl) return;
  if (audioEl.__driftHandlersAttached) {
    return;
  }
  audioEl.__driftHandlersAttached = true;

  audioEl.addEventListener('timeupdate', () => {
    audioHealth.lastTimeUpdate = Date.now();
    audioHealth.bufferingStarted = null;
    audioHealth.isHealthy = true;
    audioHealth.lastObservedTime = Number(elements.audio.currentTime) || audioHealth.lastObservedTime;
    if (Number.isFinite(elements.audio.currentTime)) {
      state.audioClockEpoch = Date.now() - Number(elements.audio.currentTime) * 1000;
    }
    if (audioHealth.stallTimer) {
      clearTimeout(audioHealth.stallTimer);
      audioHealth.stallTimer = null;
    }
    connectionHealth.audio.status = 'connected';
    updateConnectionHealthUI();

    if (state.pendingProgressStart && audioCallbacks.clearPendingProgressStart && audioCallbacks.startProgressAnimationFromPosition) {
      const audioReady = !elements.audio.paused && elements.audio.readyState >= 2;
      const audioClock = Number(elements.audio.currentTime);
      if (audioReady && Number.isFinite(audioClock) && audioClock > 0.05) {
        const pending = state.pendingProgressStart;
        audioCallbacks.clearPendingProgressStart();
        audioCallbacks.startProgressAnimationFromPosition(
          pending.durationSeconds,
          pending.startPositionSeconds,
          { ...pending.options, deferIfAudioIdle: false }
        );
      }
    }

    const audioClock = Number(elements.audio.currentTime);
    if (Number.isFinite(audioClock) && Number.isFinite(state.audioTrackStartClock) && state.playbackDurationSeconds > 0) {
      const audioElapsed = Math.max(0, audioClock - state.audioTrackStartClock);
      const visualElapsed = Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
      const drift = Math.abs(audioElapsed - visualElapsed);
      if (drift > 1.25 && audioCallbacks.startProgressAnimationFromPosition) {
        debugLog('timing', 'Audio-driven resync', { audioClock, audioElapsed, visualElapsed, drift });
        const trackId = state.latestCurrentTrack?.identifier || null;
        audioCallbacks.startProgressAnimationFromPosition(state.playbackDurationSeconds, audioElapsed, { resync: true, trackId });
      }
    }

    if (audioCallbacks.maybeApplyPendingTrackUpdate) {
      audioCallbacks.maybeApplyPendingTrackUpdate('timeupdate');
    }
  });

  audioEl.addEventListener('waiting', () => {
    console.log('⏳ Audio buffering...');
    audioHealth.bufferingStarted = Date.now();
    audioHealth.lastObservedTime = Number(elements.audio.currentTime) || audioHealth.lastObservedTime;
  });

  audioEl.addEventListener('suspend', () => {
    clearAudioLoadPending('suspend');
  });

  audioEl.addEventListener('abort', () => {
    clearAudioLoadPending('abort');
  });

  audioEl.addEventListener('emptied', () => {
    clearAudioLoadPending('emptied');
  });

  audioEl.addEventListener('playing', () => {
    console.log('▶️ Audio playing');
    clearAudioLoadPending('playing');
    audioHealth.bufferingStarted = null;
    audioHealth.lastTimeUpdate = Date.now();
    audioHealth.isHealthy = true;
    audioHealth.lastObservedTime = Number(elements.audio.currentTime) || audioHealth.lastObservedTime;
    if (audioHealth.stallTimer) {
      clearTimeout(audioHealth.stallTimer);
      audioHealth.stallTimer = null;
    }
    if (!state.hasSuccessfulAudioStart) {
      state.hasSuccessfulAudioStart = true;
    }
    if (state.audioStartupGraceUntil) {
      clearAudioStartupGrace();
    }
    if (audioHealth.pendingGraceTimer) {
      clearTimeout(audioHealth.pendingGraceTimer);
      audioHealth.pendingGraceTimer = null;
    }
    if (audioHealth.pendingQuarantineTimer) {
      clearTimeout(audioHealth.pendingQuarantineTimer);
      audioHealth.pendingQuarantineTimer = null;
    }
    if (state.connectionQuarantineUntil) {
      resetConnectionQuarantine('audio-playing');
    }
    clearPlayRetryTimer();
    connectionHealth.audio.status = 'connected';
    updateConnectionHealthUI();
    if (state.awaitingSSE && !connectionHealth.currentEventSource && audioCallbacks.connectSSE) {
      state.awaitingSSE = false;
      audioCallbacks.connectSSE();
    }
  });

  audioEl.addEventListener('error', (e) => {
    console.error('❌ Audio error - session is dead', e);
    clearAudioLoadPending('error');

    const mediaError = elements.audio.error;
    if (mediaError) {
      console.error('🎵 Audio error details:', {
        code: mediaError.code,
        message: mediaError.message,
        networkState: elements.audio.networkState,
        readyState: elements.audio.readyState,
        src: elements.audio.currentSrc,
        currentTime: elements.audio.currentTime,
        duration: elements.audio.duration
      });
    }

    audioHealth.isHealthy = false;
    connectionHealth.audio.status = 'error';
    updateConnectionHealthUI();

    handleDeadAudioSession();
  });

  audioEl.addEventListener('stalled', () => {
    console.warn('⏳ Audio reported stalled; verifying...');
    logAudioDiagnostics('audio-stalled-event', { event: 'stalled' });
    if (recordAudioInstability('stall')) {
      return;
    }
    clearAudioLoadPending('stalled');

    if (audioHealth.stallTimer) {
      clearTimeout(audioHealth.stallTimer);
    }

    const stallSnapshot = {
      time: Number(elements.audio.currentTime) || 0,
      readyState: elements.audio.readyState
    };

    audioHealth.stallTimer = setTimeout(() => {
      audioHealth.stallTimer = null;

      const now = Date.now();
      const timeSinceUpdate = audioHealth.lastTimeUpdate ? now - audioHealth.lastTimeUpdate : Infinity;
      const currentTime = Number(elements.audio.currentTime) || 0;
      const advanced = Math.abs(currentTime - stallSnapshot.time) > 0.1;
      const readyOk = elements.audio.readyState >= 3;

      if (advanced || readyOk || timeSinceUpdate <= 1500) {
        console.log('✅ Audio stall cleared without intervention');
        return;
      }

      console.error('❌ Audio stalled - network failed (confirmed)');
      audioHealth.isHealthy = false;
      connectionHealth.audio.status = 'error';
      updateConnectionHealthUI();
      handleDeadAudioSession('stalled');
    }, 1500);
  });

  audioEl.addEventListener('loadstart', () => console.log('🎵 Load started'));
  audioEl.addEventListener('canplay', () => console.log('🎵 Can play'));
  audioEl.addEventListener('canplay', () => {
    if (state.isStarted) return;
    // Prevent auto-play before user interaction
  });
  audioEl.addEventListener('canplaythrough', () => console.log('🎵 Can play through'));
  audioEl.addEventListener('play', () => {
    if (state.pendingInitialTrackTimer) return;

    state.pendingInitialTrackTimer = setTimeout(() => {
      const hasTrack = state.latestCurrentTrack && state.latestCurrentTrack.identifier;
      if (!hasTrack) {
        state.manualNextTrackOverride = false;
        state.skipTrayDemotionForTrack = null;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        state.selectedIdentifier = null;
        state.stackIndex = 0;
        console.warn('🛰️ ACTION initial-track-missing: no SSE track after 10s, requesting refresh');
        if (audioCallbacks.fullResync) {
          audioCallbacks.fullResync();
        }
      }
    }, 10000);
  });
}

// ====== Rebuild Audio Element ======

export function rebuildAudioElement(reason = 'unknown') {
  const oldAudio = elements.audio;
  if (!oldAudio || !oldAudio.parentElement) {
    console.warn('⚠️ Unable to rebuild audio element - missing node', { reason });
    return false;
  }

  const parent = oldAudio.parentElement;
  const previousVolume = Number.isFinite(oldAudio.volume) ? oldAudio.volume : 0.85;

  try {
    oldAudio.pause();
    oldAudio.removeAttribute('src');
    if (typeof oldAudio.load === 'function') {
      oldAudio.load();
    }
  } catch (err) {
    console.warn('⚠️ Failed to reset old audio element during rebuild', err);
  }

  const newAudio = oldAudio.cloneNode(false);
  parent.replaceChild(newAudio, oldAudio);
  elements.audio = newAudio;
  delete newAudio.__driftHandlersAttached;
  newAudio.volume = previousVolume;

  state.audioElementVersion = (state.audioElementVersion || 1) + 1;
  state.audioElementRebuilds = (state.audioElementRebuilds || 0) + 1;

  attachBaseAudioEventListeners(newAudio);

  if (state.isStarted && audioCallbacks.composeStreamEndpoint) {
    const streamUrl = audioCallbacks.composeStreamEndpoint(state.streamFingerprint, Date.now());
    connectAudioStream(streamUrl, { reason: `rebuild-${reason}` });
    clearPlayRetryTimer();
    playAudioElement(`rebuild-${reason}`);
  }

  return true;
}

// ====== Initialization ======

export function initializeAudioManager() {
  initializeMediaStreamController();
  attachBaseAudioEventListeners();
}

// Expose functions globally
if (typeof window !== 'undefined') {
  window.setAudioCallbacks = setAudioCallbacks;
  window.updateConnectionHealthUI = updateConnectionHealthUI;
  window.logAudioDiagnostics = logAudioDiagnostics;
  window.clearPlayRetryTimer = clearPlayRetryTimer;
  window.schedulePlayRetry = schedulePlayRetry;
  window.playAudioElement = playAudioElement;
  window.markAudioLoadPending = markAudioLoadPending;
  window.clearAudioLoadPending = clearAudioLoadPending;
  window.extendAudioStartupGrace = extendAudioStartupGrace;
  window.isWithinAudioStartupGrace = isWithinAudioStartupGrace;
  window.clearAudioStartupGrace = clearAudioStartupGrace;
  window.enterConnectionQuarantine = enterConnectionQuarantine;
  window.isConnectionQuarantined = isConnectionQuarantined;
  window.resetConnectionQuarantine = resetConnectionQuarantine;
  window.connectAudioStream = connectAudioStream;
  window.initializeMediaStreamController = initializeMediaStreamController;
  window.recordAudioInstability = recordAudioInstability;
  window.handleDeadAudioSession = handleDeadAudioSession;
  window.startAudioHealthMonitoring = startAudioHealthMonitoring;
  window.attachBaseAudioEventListeners = attachBaseAudioEventListeners;
  window.rebuildAudioElement = rebuildAudioElement;
  window.initializeAudioManager = initializeAudioManager;
}
