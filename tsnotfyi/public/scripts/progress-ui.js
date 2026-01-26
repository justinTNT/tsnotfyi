// Progress bar and playback clock UI
// Dependencies: globals.js (state, elements, rootElement, PROGRESS_*, LOCKOUT_*, TRACK_*, etc.)
// Dependencies: danger-zone.js (exitDangerZoneVisualState, safelyExitCardsDormantState)

import {
    state,
    elements,
    rootElement,
    debugLog,
    PROGRESS_TICK_INTERVAL_MS,
    PROGRESS_ENVELOPE_STRETCH,
    PROGRESS_PULSE_AMPLITUDE,
    PROGRESS_AUDIO_WAIT_TIMEOUT_MS,
    PROGRESS_DESYNC_MARGIN_SECONDS,
    LOCKOUT_THRESHOLD_SECONDS,
    TRACK_SWITCH_PROGRESS_THRESHOLD,
    CURRENT_TRACK_APPLY_LEAD_MS,
    MAX_PENDING_TRACK_DELAY_MS,
    TRACK_CHANGE_DESYNC_GRACE_MS
} from './globals.js';
import { exitDangerZoneVisualState, safelyExitCardsDormantState } from './danger-zone.js';

let playbackClockAnimationId = null;
let lastProgressPhase = null;

export function startProgressAnimation(durationSeconds) {
    startProgressAnimationFromPosition(durationSeconds, 0, { resync: false, trackChanged: true });
}

export function clearPendingProgressStart() {
    if (state.pendingProgressStartTimer) {
        clearTimeout(state.pendingProgressStartTimer);
        state.pendingProgressStartTimer = null;
    }
    state.pendingProgressStart = null;
}

function ensurePlaybackClockTicker() {
    if (typeof window === 'undefined') {
        return;
    }
    if (playbackClockAnimationId !== null) {
        return;
    }
    const tick = () => {
        playbackClockAnimationId = window.requestAnimationFrame(tick);
        if (state.playbackStartTimestamp && state.playbackDurationSeconds > 0) {
            updatePlaybackClockDisplay();
        }
    };
    playbackClockAnimationId = window.requestAnimationFrame(tick);
}

function stopPlaybackClockTicker() {
    if (typeof window === 'undefined') {
        return;
    }
    if (playbackClockAnimationId !== null) {
        window.cancelAnimationFrame(playbackClockAnimationId);
        playbackClockAnimationId = null;
    }
}

function applyProgressEnvelope(raw) {
    if (raw <= 0) return 0;
    if (raw >= 1) return 1;
    const envelope = Math.tanh(PROGRESS_ENVELOPE_STRETCH * raw) / Math.tanh(PROGRESS_ENVELOPE_STRETCH);
    const pulse = envelope + PROGRESS_PULSE_AMPLITUDE * (1 - Math.cos(Math.PI * envelope));
    return Math.min(raw, Math.min(1, Math.max(0, pulse)));
}

export function renderProgressBar(progressFraction) {
    const clamped = Math.min(Math.max(progressFraction, 0), 1);
    const visualProgress = applyProgressEnvelope(clamped);
    const phase = clamped <= 0.5 ? 'fill' : 'drain';
    if (phase !== lastProgressPhase) {
        debugLog('progress', `Progress phase → ${phase}`, { progress: Number(clamped.toFixed(3)) });
        lastProgressPhase = phase;
    }
    const background = document.getElementById('background');


    if (clamped <= 0.5) {
        const widthPercent = visualProgress * 2 * 100;
        elements.progressWipe.style.left = '0%';
        elements.progressWipe.style.right = 'auto';
        elements.progressWipe.style.width = `${widthPercent}%`;

        if (background) {
            let green = Math.floor(clamped * 10);
            background.style.background = `linear-gradient(135deg, #235, #4${green}3)`;
        }
    } else {
        const phase2Progress = Math.max(0, visualProgress - 0.5) * 2;
        elements.progressWipe.style.left = `${phase2Progress * 100}%`;
        elements.progressWipe.style.right = 'auto';
        elements.progressWipe.style.width = `${(1 - phase2Progress) * 100}%`;

        if (background) {
            let green = 10 - Math.floor(clamped * 10);
            background.style.background = `linear-gradient(135deg, #235, #4${green}3)`;
        }
    }

    if (state.pendingExplorerNext && clamped >= TRACK_SWITCH_PROGRESS_THRESHOLD) {
        maybeApplyDeferredNextTrack('progress');
    }
}

export function formatTimecode(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '--:--';
    }
    const wholeSeconds = Math.floor(seconds);
    const minutes = Math.floor(wholeSeconds / 60);
    const secs = wholeSeconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function updatePlaybackClockDisplay(forceSeconds = null) {
    if (!elements.playbackClock) return;

    if (!state.playbackStartTimestamp || state.playbackDurationSeconds <= 0) {
        elements.playbackClock.textContent = '';
        elements.playbackClock.classList.add('is-hidden');
        return;
    }

    let elapsedSeconds;
    if (forceSeconds !== null) {
        elapsedSeconds = forceSeconds;
    } else {
        // Prefer audio element's currentTime as source of truth
        const audioTime = elements.audio && Number(elements.audio.currentTime);
        const audioOffset = state.audioTrackStartClock || 0;
        // Use audio time once started, regardless of pause state (avoids source-switching during buffering)
        const audioHasStarted = audioTime > 0;
        if (audioHasStarted && Number.isFinite(audioTime) && Number.isFinite(audioOffset) && audioTime >= audioOffset) {
            elapsedSeconds = audioTime - audioOffset;
        } else {
            // Fallback to wall-clock (before audio starts, or in tests)
            elapsedSeconds = Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
        }
    }

    const clampedElapsed = Math.min(Math.max(0, elapsedSeconds), state.playbackDurationSeconds);
    const formatted = formatTimecode(clampedElapsed);
    if (formatted === '--:--') {
        elements.playbackClock.textContent = '';
        elements.playbackClock.classList.add('is-hidden');
        return;
    }

    elements.playbackClock.textContent = formatted;
    elements.playbackClock.classList.remove('is-hidden');
}

export function clearPlaybackClock() {
    state.playbackStartTimestamp = null;
    state.playbackDurationSeconds = 0;
    updatePlaybackClockDisplay(null);
}

function shouldLockInteractions(elapsedSeconds, totalDuration) {
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
        return false;
    }
    const remaining = Math.max(totalDuration - elapsedSeconds, 0);
    return remaining <= LOCKOUT_THRESHOLD_SECONDS;
}

// Tail progress is deprecated - the new clock-animation.js handles end-of-track animations
// These functions are kept as no-ops for backward compatibility
export function applyTailProgress(value = 0) {
    // No-op - tail progress CSS variables removed in favor of clock animation system
    state.tailProgress = 0;
}

export function updateTailProgress(elapsedSeconds, totalDuration) {
    // No-op - tail progress removed in favor of clock animation system
    // The new system uses trigger conditions (t-30s or empty playlist) instead
}

export function getVisualProgressFraction() {
    if (!Number.isFinite(state.playbackDurationSeconds) || state.playbackDurationSeconds <= 0) {
        return null;
    }
    if (!Number.isFinite(state.playbackStartTimestamp)) {
        return null;
    }

    let elapsedSeconds;
    // Prefer audio element's currentTime as source of truth
    const audioTime = elements.audio && Number(elements.audio.currentTime);
    const audioOffset = state.audioTrackStartClock || 0;
    // Use audio time once started, regardless of pause state (avoids source-switching during buffering)
    const audioHasStarted = audioTime > 0;
    if (audioHasStarted && Number.isFinite(audioTime) && Number.isFinite(audioOffset) && audioTime >= audioOffset) {
        elapsedSeconds = audioTime - audioOffset;
    } else {
        // Fallback to wall-clock (before audio starts, or in tests)
        elapsedSeconds = Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
    }

    return Math.min(1, Math.max(0, elapsedSeconds) / state.playbackDurationSeconds);
}

function getServerClockOffsetMs() {
    return Number.isFinite(state.serverClockOffsetMs) ? state.serverClockOffsetMs : 0;
}

function toLocalServerTime(serverTimestampMs) {
    if (!Number.isFinite(serverTimestampMs)) {
        return null;
    }
    return serverTimestampMs - getServerClockOffsetMs();
}

function estimateServerLeadMs(startTimeMs, elapsedMs) {
    if (!Number.isFinite(startTimeMs)) {
        return null;
    }
    const effectiveElapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
    const localStart = toLocalServerTime(startTimeMs);
    if (!Number.isFinite(localStart)) {
        return null;
    }
    return localStart + effectiveElapsed - Date.now();
}

export function attemptApplyCurrentTrack({ track, trackId, trackChanged, source, context = {}, apply }) {
    const audioElement = elements.audio || null;
    const audioClock = audioElement ? Number(audioElement.currentTime) : NaN;
    const audioPlaybackActive = trackChanged
        && audioElement
        && !audioElement.paused
        && audioElement.readyState >= 2
        && Number.isFinite(audioClock);
    const audioLoadPending = state.audioLoadPending === true;

    let leadMs = trackChanged ? estimateServerLeadMs(context.startTimeMs, context.elapsedMs) : null;
    if (audioPlaybackActive) {
        leadMs = 0;
    }

    const progressFraction = getVisualProgressFraction();
    const shouldDelayForProgress =
        trackChanged &&
        source === 'heartbeat' &&
        progressFraction !== null &&
        progressFraction < TRACK_SWITCH_PROGRESS_THRESHOLD &&
        Number.isFinite(leadMs) &&
        leadMs > CURRENT_TRACK_APPLY_LEAD_MS;

    const shouldDelayForLead = trackChanged && Number.isFinite(leadMs) && leadMs > CURRENT_TRACK_APPLY_LEAD_MS;
    const shouldDelayForAudio = trackChanged && audioLoadPending;
    if (shouldDelayForLead || shouldDelayForAudio || shouldDelayForProgress) {
        if (state.pendingTrackUpdate && state.pendingTrackUpdate.trackId === trackId) {
            state.pendingTrackUpdate.context = { ...context };
            state.pendingTrackUpdate.lastLeadMs = leadMs;
            state.pendingTrackUpdate.updatedAt = Date.now();
        } else {
            state.pendingTrackUpdate = {
                trackId,
                context: { ...context },
                apply,
                source,
                createdAt: Date.now(),
                lastLeadMs: leadMs
            };
        }
        const delayContext = {
            source,
            leadMs,
            track: track?.title || trackId || 'unknown',
            audioLoadPending: shouldDelayForAudio,
            progressFraction
        };
        debugLog('timing', 'Delaying track apply', delayContext);
        console.warn('⏳ Delaying track apply until audio catches up', delayContext);
        return 'pending';
    }

    if (state.pendingTrackUpdate && state.pendingTrackUpdate.trackId === trackId) {
        state.pendingTrackUpdate = null;
    }

    apply(context);
    return 'applied';
}

export function maybeApplyPendingTrackUpdate(trigger) {
    const pending = state.pendingTrackUpdate;
    if (!pending || typeof pending.apply !== 'function') {
        return;
    }

    const now = Date.now();
    const ctx = pending.context || {};
    const elapsedBase = Number.isFinite(ctx.elapsedMs) ? ctx.elapsedMs : null;
    const timestampMs = Number.isFinite(ctx.timestampMs) ? ctx.timestampMs : null;
    const localTimestampMs = Number.isFinite(timestampMs) ? toLocalServerTime(timestampMs) : null;
    const effectiveElapsedMs = elapsedBase !== null && Number.isFinite(localTimestampMs)
        ? elapsedBase + (now - localTimestampMs)
        : elapsedBase;
    const leadMs = estimateServerLeadMs(ctx.startTimeMs, effectiveElapsedMs);
    pending.lastLeadMs = leadMs;

    if (
        !Number.isFinite(leadMs) ||
        leadMs <= CURRENT_TRACK_APPLY_LEAD_MS ||
        now - pending.createdAt > MAX_PENDING_TRACK_DELAY_MS
    ) {
        if (state.audioLoadPending) {
            debugLog('timing', 'Pending track apply still waiting for audio load', { trigger, leadMs });
            return;
        }
        if (pending.source === 'heartbeat') {
            const progressFraction = getVisualProgressFraction();
            if (progressFraction !== null && progressFraction < TRACK_SWITCH_PROGRESS_THRESHOLD) {
                debugLog('timing', 'Pending track apply waiting for progress threshold', {
                    trigger,
                    progressFraction
                });
                return;
            }
        }
        state.pendingTrackUpdate = null;
        pending.apply({
            ...ctx,
            elapsedMs: effectiveElapsedMs,
            startTimeMs: ctx.startTimeMs
        });
    }
}

export function maybeApplyDeferredNextTrack(trigger = 'progress', options = {}) {
    const pending = state.pendingExplorerNext;
    if (!pending || !state.latestExplorerData) {
        return false;
    }
    if (state.manualNextTrackOverride && !options.force) {
        return false;
    }
    if (!options.force) {
        const progressFraction = getVisualProgressFraction();
        if (progressFraction === null || progressFraction < TRACK_SWITCH_PROGRESS_THRESHOLD) {
            return false;
        }
    }

    state.pendingExplorerNext = null;
    state.latestExplorerData.nextTrack = pending.nextTrack;

    const nextTrackId = pending.selectionId
        || pending.nextTrack?.track?.identifier
        || pending.nextTrack?.identifier
        || null;

    if (nextTrackId) {
        state.serverNextTrack = nextTrackId;
        if (!state.manualNextTrackOverride) {
            state.selectedIdentifier = nextTrackId;
        }
    }

    if (pending.directionKey) {
        state.serverNextDirection = pending.directionKey;
    }

    if (typeof window.createDimensionCards === 'function') {
        window.createDimensionCards(state.latestExplorerData, { skipExitAnimation: true, forceRedraw: true });
    }
    console.log(`🕘 Applied deferred explorer next track (${pending.directionKey || 'unknown'}) via ${trigger}`);
    return true;
}

export function startProgressAnimationFromPosition(durationSeconds, startPositionSeconds = 0, options = {}) {
    let { resync = false, trackChanged = false, forceStart = false, trackId = null, deferIfAudioIdle = true } = options;
    const normalizedDuration = Number.isFinite(durationSeconds) ? Math.max(durationSeconds, 0) : 0;
    durationSeconds = normalizedDuration;
    let effectiveStartPosition = Number.isFinite(startPositionSeconds) ? startPositionSeconds : 0;
    if (trackChanged) {
        effectiveStartPosition = 0;
        state.lastTrackChangeTs = Date.now();
        state.lastTrackChangeGraceLog = null;
    }
    const safeDuration = Math.max(durationSeconds, 0.001);
    const isFirstProgress = !state.progressEverStarted;
    const desyncOverflow = safeDuration > 0 ? (effectiveStartPosition - safeDuration) : 0;
    const withinTrackChangeGrace = state.lastTrackChangeTs &&
        (Date.now() - state.lastTrackChangeTs) <= TRACK_CHANGE_DESYNC_GRACE_MS;
    if (desyncOverflow > PROGRESS_DESYNC_MARGIN_SECONDS) {
        const desyncTrackId = trackId || state.latestCurrentTrack?.identifier || null;
        const logPayload = {
            reportedStart: Number(effectiveStartPosition.toFixed(3)),
            safeDuration,
            overflowSeconds: Number(desyncOverflow.toFixed(3)),
            trackId: desyncTrackId
        };
        if (withinTrackChangeGrace) {
            const graceAgeMs = Date.now() - state.lastTrackChangeTs;
            const shouldLogGrace =
                !state.lastTrackChangeGraceLog ||
                state.lastTrackChangeGraceLog.trackId !== desyncTrackId ||
                graceAgeMs - state.lastTrackChangeGraceLog.ageMs >= 1000;
            if (shouldLogGrace) {
                console.warn('⏱️ Progress desync ignored during track-change grace', {
                    ...logPayload,
                    graceWindowMs: TRACK_CHANGE_DESYNC_GRACE_MS,
                    ageMs: graceAgeMs
                });
                state.lastTrackChangeGraceLog = { trackId: desyncTrackId, ageMs: graceAgeMs };
            }
            effectiveStartPosition = 0;
            resync = true;
        } else {
            const shouldLogDesync =
                !state.lastProgressDesync ||
                state.lastProgressDesync.trackId !== desyncTrackId ||
                Math.abs(desyncOverflow - (state.lastProgressDesync.overflow || 0)) > 5;
            if (shouldLogDesync) {
                console.warn('⏱️ Progress desync detected; clamping to track end', logPayload);
                state.lastProgressDesync = {
                    trackId: desyncTrackId,
                    overflow: desyncOverflow,
                    loggedAt: Date.now()
                };
            }
            effectiveStartPosition = safeDuration;
            resync = true;
            trackChanged = false;
        }
    } else if (trackChanged) {
        state.lastProgressDesync = null;
    }
    startPositionSeconds = effectiveStartPosition;
    debugLog('progress', 'startProgressAnimationFromPosition()', {
        durationSeconds,
        startPositionSeconds,
        resync,
        trackChanged,
        stateDuration: state.playbackDurationSeconds,
        stateStartTimestamp: state.playbackStartTimestamp
    });

    if (!resync || trackChanged) {
        applyTailProgress(0);
    }

    if (trackChanged) {
        // Reset danger zone state for new track
        if (typeof window.resetDangerZoneState === 'function') {
            window.resetDangerZoneState();
        }
        lastProgressPhase = null;
        exitDangerZoneVisualState({ reason: 'track-change' });
    }

    if (resync && state.playbackStartTimestamp) {
        const priorElapsed = Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
        const targetElapsed = Math.max(0, startPositionSeconds);
        const priorDuration = state.playbackDurationSeconds || 0;
        const targetDuration = Number.isFinite(durationSeconds) ? durationSeconds : priorDuration;

        const elapsedDelta = Math.abs(priorElapsed - targetElapsed);
        const durationDelta = Math.abs(priorDuration - targetDuration);
        debugLog('progress', 'resync delta comparison', {
            priorElapsed,
            targetElapsed,
            elapsedDelta,
            priorDuration,
            targetDuration,
            durationDelta
        });

        if (elapsedDelta < 1 && durationDelta < 1 && priorDuration > 0) {
            state.playbackDurationSeconds = targetDuration;
            state.playbackStartTimestamp = Date.now() - targetElapsed * 1000;
            const effectiveProgress = targetDuration > 0 ? targetElapsed / targetDuration : 0;
            renderProgressBar(effectiveProgress);
            updatePlaybackClockDisplay(targetElapsed);
            return true;
        }
    }

    if (state.progressAnimation) {
        clearInterval(state.progressAnimation);
        state.progressAnimation = null;
    }

    if (!resync || trackChanged) {
        elements.progressWipe.style.width = '0%';
        elements.progressWipe.style.left = '0%';
        elements.progressWipe.style.right = 'auto';
        elements.fullscreenProgress.classList.add('active');
        if (typeof window.unlockCardInteractions === 'function') {
            window.unlockCardInteractions();
        }
        if (typeof window.markActivity === 'function') {
            window.markActivity();
        }
    } else {
        elements.fullscreenProgress.classList.add('active');
    }

    const clampedStartPosition = Math.min(Math.max(startPositionSeconds, 0), safeDuration);
    const initialProgress = safeDuration > 0 ? (clampedStartPosition / safeDuration) : 0;
    const remainingDuration = Math.max((safeDuration - clampedStartPosition) * 1000, 0);

    const trackCurrentlyMatching =
        trackId &&
        state.latestCurrentTrack &&
        (state.latestCurrentTrack.identifier === trackId || state.latestCurrentTrack.trackMd5 === trackId);
    if (trackChanged && !trackCurrentlyMatching && !forceStart) {
        console.warn('⚠️ Progress start aborted: heartbeat reference mismatch', {
            durationSeconds,
            clampedStartPosition,
            trackChanged,
            resync,
            hadActiveDuration: Boolean(state.playbackDurationSeconds),
            trackId: options.trackId || null
        });
        state.playbackDurationSeconds = 0;
        state.playbackStartTimestamp = null;
        state.audioTrackStartClock = null;
        stopPlaybackClockTicker();
        renderProgressBar(0);
        updatePlaybackClockDisplay(null);
        applyTailProgress(0);
        return false;
    }

    const audioEl = elements.audio || null;
    const audioClock = audioEl ? Number(audioEl.currentTime) : NaN;
    const audioReady = audioEl && !audioEl.paused && audioEl.readyState >= 2;
    const audioHasElapsed = Number.isFinite(audioClock) && audioClock > 0.05;
    const shouldDeferForAudio = !forceStart && deferIfAudioIdle !== false &&
        (!audioReady || !audioHasElapsed || state.audioLoadPending);
    const wantsAudioDelay = (trackChanged || shouldDeferForAudio) && shouldDeferForAudio;

    if (wantsAudioDelay && isFirstProgress) {
        console.warn('⏳ First-track progress forcing immediate start despite audio not ready', {
            audioReady,
            audioHasElapsed,
            audioClock,
            audioLoadPending: state.audioLoadPending
        });
    }

    if (wantsAudioDelay && !isFirstProgress) {
        state.playbackDurationSeconds = 0;
        state.playbackStartTimestamp = null;
        state.audioTrackStartClock = null;
        state.pendingProgressStart = {
            durationSeconds,
            startPositionSeconds,
            options: { ...options, deferIfAudioIdle: false }
        };
        if (state.pendingProgressStartTimer) {
            clearTimeout(state.pendingProgressStartTimer);
        }
        state.pendingProgressStartTimer = setTimeout(() => {
            const pending = state.pendingProgressStart;
            state.pendingProgressStartTimer = null;
            state.pendingProgressStart = null;
            if (pending) {
                console.warn('⏳ Progress start fallback after audio wait timeout');
                startProgressAnimationFromPosition(
                    pending.durationSeconds,
                    pending.startPositionSeconds,
                    { ...pending.options, deferIfAudioIdle: false }
                );
            }
        }, PROGRESS_AUDIO_WAIT_TIMEOUT_MS);
        debugLog('progress', 'Audio not ready; deferring progress animation until playback', {
            audioReady,
            audioHasElapsed,
            audioClock,
            audioLoadPending: state.audioLoadPending
        });
        return false;
    }

    clearPendingProgressStart();
    state.progressEverStarted = true;

    state.playbackDurationSeconds = safeDuration;
    state.playbackStartTimestamp = Date.now() - clampedStartPosition * 1000;
    const currentAudioClock = elements.audio && Number(elements.audio.currentTime);
    if (Number.isFinite(currentAudioClock)) {
        state.audioTrackStartClock = currentAudioClock - clampedStartPosition;
    }
    ensurePlaybackClockTicker();
    updateTailProgress(clampedStartPosition, safeDuration);

    renderProgressBar(initialProgress);
    updatePlaybackClockDisplay(clampedStartPosition);

    const initialShouldLock = shouldLockInteractions(clampedStartPosition, safeDuration);
    // Old danger zone and card locking logic removed
    // The new clock-animation.js system handles pack-away animations
    // triggered at t-30s when playlist is empty, or manually via tray click
    if (typeof window.publishInteractionState === 'function') {
        window.publishInteractionState();
    }

    if (remainingDuration <= 0) {
        debugLog('progress', 'Remaining duration <= 0; forcing completion');
        renderProgressBar(1);
        updatePlaybackClockDisplay(safeDuration);
        applyTailProgress(1);
        stopPlaybackClockTicker();
        return true;
    }

    // Track displayed progress separately from audio progress for smooth animation
    let displayedProgress = initialProgress;
    const SMOOTH_FACTOR = 0.15; // How quickly to catch up (0-1, higher = faster)
    const HARD_RESET_THRESHOLD = 0.1; // Jump if more than 10% off

    state.progressAnimation = setInterval(() => {
        // Get target progress from audio element (source of truth)
        let targetProgress;
        const audioTime = elements.audio && Number(elements.audio.currentTime);
        const audioOffset = state.audioTrackStartClock || 0;
        // Use audio time once it's started (> 0), regardless of pause state
        // This avoids jumping between sources during buffering
        const audioHasStarted = audioTime > 0;
        if (audioHasStarted && Number.isFinite(audioTime) && Number.isFinite(audioOffset) && audioTime >= audioOffset) {
            const elapsedSeconds = audioTime - audioOffset;
            targetProgress = Math.min(1, Math.max(0, elapsedSeconds / safeDuration));
        } else {
            // Fallback: wall clock (used before audio starts, or in tests)
            const wallElapsed = (Date.now() - state.playbackStartTimestamp) / 1000;
            targetProgress = Math.min(1, Math.max(0, wallElapsed / safeDuration));
        }

        // Smoothly interpolate toward target, or hard reset if too far off
        const delta = targetProgress - displayedProgress;
        if (Math.abs(delta) > HARD_RESET_THRESHOLD) {
            // Too far off - hard reset
            displayedProgress = targetProgress;
        } else {
            // Smooth interpolation toward target
            displayedProgress += delta * SMOOTH_FACTOR;
        }

        const progress = Math.min(1, Math.max(0, displayedProgress));
        renderProgressBar(progress);
        updatePlaybackClockDisplay();

        // Old danger zone triggers removed - new clock-animation.js handles pack-away
        // The new system triggers at t-30s when playlist is empty

        if (progress >= 1) {
            clearInterval(state.progressAnimation);
            state.progressAnimation = null;
            updatePlaybackClockDisplay(safeDuration);
            applyTailProgress(1);
            stopPlaybackClockTicker();
            debugLog('progress', 'Progress animation completed', { safeDuration });
        }
        maybeApplyPendingTrackUpdate('progress-interval');
    }, PROGRESS_TICK_INTERVAL_MS);
    return true;
}

export function stopProgressAnimation() {
    if (state.progressAnimation) {
        clearInterval(state.progressAnimation);
        state.progressAnimation = null;
    }
    elements.fullscreenProgress.classList.remove('active');
    elements.progressWipe.style.width = '0%';
    elements.progressWipe.style.left = '0%';
    elements.progressWipe.style.right = 'auto';

    exitDangerZoneVisualState({ reason: 'progress-stop' });
    console.log('🛑 Stopped progress animation');
    if (typeof window.publishInteractionState === 'function') {
        window.publishInteractionState();
    }
    clearPlaybackClock();
    stopPlaybackClockTicker();
    clearPendingProgressStart();
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    // Old danger zone state removed - now using clock-animation.js system
    window.resetDangerZoneState = function() {
        // No-op stub for backward compatibility
    };
    window.startProgressAnimation = startProgressAnimation;
    window.startProgressAnimationFromPosition = startProgressAnimationFromPosition;
    window.stopProgressAnimation = stopProgressAnimation;
    window.getVisualProgressFraction = getVisualProgressFraction;
    window.maybeApplyDeferredNextTrack = maybeApplyDeferredNextTrack;
    window.applyTailProgress = applyTailProgress;
    window.updateTailProgress = updateTailProgress;
    window.renderProgressBar = renderProgressBar;
    window.clearPendingProgressStart = clearPendingProgressStart;
    window.maybeApplyPendingTrackUpdate = maybeApplyPendingTrackUpdate;
    window.attemptApplyCurrentTrack = attemptApplyCurrentTrack;
    window.formatTimecode = formatTimecode;
    window.updatePlaybackClockDisplay = updatePlaybackClockDisplay;
    window.clearPlaybackClock = clearPlaybackClock;
}
