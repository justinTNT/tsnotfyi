// Progress bar and playback clock UI
// Dependencies: globals.js (state, elements, rootElement, PROGRESS_*, LOCKOUT_*, TRACK_*, etc.)
// Dependencies: card-state.js (safelyExitCardsDormantState)

import {
    state,
    elements,
    rootElement,
    PROGRESS_TICK_INTERVAL_MS,
    PROGRESS_ENVELOPE_STRETCH,
    PROGRESS_PULSE_AMPLITUDE,
    PROGRESS_AUDIO_WAIT_TIMEOUT_MS,
    PROGRESS_DESYNC_MARGIN_SECONDS,
    LOCKOUT_THRESHOLD_SECONDS,
    TRACK_SWITCH_PROGRESS_THRESHOLD,
    TRACK_CHANGE_DESYNC_GRACE_MS
} from './globals.js';
import { createLogger } from './log.js';
const log = createLogger('progress');
import { safelyExitCardsDormantState } from './card-state.js';
import { playlistHasItems } from './playlist-tray.js';

let playbackClockAnimationId = null;
let lastProgressPhase = null;
let lastTrackChangeTs = 0;
let midpointWatchdogFired = false;

export function startProgressAnimation(durationSeconds, trackId = null) {
    startProgressAnimationFromPosition(durationSeconds, 0, { resync: false, trackChanged: true, trackId });
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
        log.debug(`Progress phase → ${phase}`, { progress: Number(clamped.toFixed(3)) });
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

    // Midpoint watchdog: if we're past 50% and the deck has no cards, force a refresh
    if (!midpointWatchdogFired && state.playbackDurationSeconds > 0 && clampedElapsed > state.playbackDurationSeconds * 0.5) {
        const deckContainer = document.getElementById('dimensionCards');
        const hasCards = deckContainer && deckContainer.querySelector('.dimension-card');
        if (!hasCards) {
            midpointWatchdogFired = true;
            log.warn('🐕 Midpoint watchdog: no cards at 50% — forcing refresh');
            state.manualNextTrackOverride = false;
            state.manualNextDirectionKey = null;
            state.pendingManualTrackId = null;
            if (typeof window.requestSSERefresh === 'function') {
                window.requestSSERefresh({ escalate: false });
            }
        }
    }

    const formattedElapsed = formatTimecode(clampedElapsed);
    const formattedTotal = formatTimecode(state.playbackDurationSeconds);
    if (formattedElapsed === '--:--') {
        elements.playbackClock.textContent = '';
        elements.playbackClock.classList.add('is-hidden');
        return;
    }

    // Show elapsed/total format for diagnostics (e.g., "1:23/4:56")
    elements.playbackClock.textContent = `${formattedElapsed}/${formattedTotal}`;
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
    log.info(`🕘 Applied deferred explorer next track (${pending.directionKey || 'unknown'}) via ${trigger}`);
    return true;
}

export function startProgressAnimationFromPosition(durationSeconds, startPositionSeconds = 0, options = {}) {
    let { resync = false, trackChanged = false, forceStart = false, trackId = null, deferIfAudioIdle = true } = options;
    const normalizedDuration = Number.isFinite(durationSeconds) ? Math.max(durationSeconds, 0) : 0;
    durationSeconds = normalizedDuration;
    let effectiveStartPosition = Number.isFinite(startPositionSeconds) ? startPositionSeconds : 0;
    if (trackChanged) {
        effectiveStartPosition = 0;
        lastTrackChangeTs = Date.now();
        state.lastTrackChangeGraceLog = null;
        midpointWatchdogFired = false;

        // Track-start watchdog: if deck has no cards when a new track begins, force refresh
        // Debounce: only fire once per track change (refresh re-enters this function)
        const deckContainer = document.getElementById('dimensionCards');
        const hasCards = deckContainer && deckContainer.querySelector('.dimension-card');
        if (!hasCards && state.isStarted && !state._trackStartWatchdogFired) {
            state._trackStartWatchdogFired = true;
            log.warn('🐕 Track-start watchdog: no cards at track change — forcing refresh');
            state.manualNextTrackOverride = false;
            state.manualNextDirectionKey = null;
            state.pendingManualTrackId = null;
            if (typeof window.requestSSERefresh === 'function') {
                window.requestSSERefresh({ escalate: false });
            }
        } else if (hasCards) {
            state._trackStartWatchdogFired = false;
        }
    }
    const safeDuration = Math.max(durationSeconds, 0.001);
    const isFirstProgress = !state.progressEverStarted;
    const desyncOverflow = safeDuration > 0 ? (effectiveStartPosition - safeDuration) : 0;
    const withinTrackChangeGrace = lastTrackChangeTs &&
        (Date.now() - lastTrackChangeTs) <= TRACK_CHANGE_DESYNC_GRACE_MS;
    if (desyncOverflow > PROGRESS_DESYNC_MARGIN_SECONDS) {
        const desyncTrackId = trackId || state.latestCurrentTrack?.identifier || null;
        const logPayload = {
            reportedStart: Number(effectiveStartPosition.toFixed(3)),
            safeDuration,
            overflowSeconds: Number(desyncOverflow.toFixed(3)),
            trackId: desyncTrackId
        };
        if (withinTrackChangeGrace) {
            const graceAgeMs = Date.now() - lastTrackChangeTs;
            const shouldLogGrace =
                !state.lastTrackChangeGraceLog ||
                state.lastTrackChangeGraceLog.trackId !== desyncTrackId ||
                graceAgeMs - state.lastTrackChangeGraceLog.ageMs >= 1000;
            if (shouldLogGrace) {
                log.warn('⏱️ Progress desync ignored during track-change grace', {
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
                log.warn('⏱️ Progress desync detected; clamping to track end', logPayload);
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
    log.debug('startProgressAnimationFromPosition()', {
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
        lastProgressPhase = null;
    }

    if (resync && state.playbackStartTimestamp) {
        const priorElapsed = Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
        const targetElapsed = Math.max(0, startPositionSeconds);
        const priorDuration = state.playbackDurationSeconds || 0;
        const targetDuration = Number.isFinite(durationSeconds) ? durationSeconds : priorDuration;

        const elapsedDelta = Math.abs(priorElapsed - targetElapsed);
        const durationDelta = Math.abs(priorDuration - targetDuration);
        log.debug('resync delta comparison', {
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

    // If trackId provided, verify it matches current track
    // If trackId is null, skip check (can't verify, assume it's valid)
    const trackCurrentlyMatching = !trackId || (
        state.latestCurrentTrack &&
        (state.latestCurrentTrack.identifier === trackId || state.latestCurrentTrack.trackMd5 === trackId)
    );
    if (trackChanged && !trackCurrentlyMatching && !forceStart) {
        log.warn('⚠️ Progress start aborted: heartbeat reference mismatch', {
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
        state._autoPromoted = false;
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
        log.warn('⏳ First-track progress forcing immediate start despite audio not ready', {
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
        state._autoPromoted = false;
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
                log.warn('⏳ Progress start fallback after audio wait timeout');
                startProgressAnimationFromPosition(
                    pending.durationSeconds,
                    pending.startPositionSeconds,
                    { ...pending.options, deferIfAudioIdle: false }
                );
            }
        }, PROGRESS_AUDIO_WAIT_TIMEOUT_MS);
        log.debug('Audio not ready; deferring progress animation until playback', {
            audioReady,
            audioHasElapsed,
            audioClock,
            audioLoadPending: state.audioLoadPending
        });
        return false;
    }

    clearPendingProgressStart();
    state.progressEverStarted = true;
    if (trackChanged) {
        state._autoPromoted = false;
    }

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
    if (remainingDuration <= 0) {
        log.debug('Remaining duration <= 0; forcing completion');
        renderProgressBar(1);
        updatePlaybackClockDisplay(safeDuration);
        applyTailProgress(1);
        stopPlaybackClockTicker();
        return true;
    }

    // Track displayed progress separately from audio progress for smooth animation
    let displayedProgress = initialProgress;
    let ratchetedProgress = initialProgress; // One-way ratchet: only moves forward
    const SMOOTH_FACTOR = 0.08; // How quickly to catch up (lower = smoother)
    const FORWARD_JUMP_THRESHOLD = 0.15; // Hard jump if target is >15% ahead

    // Ease-out function: fast start, slow finish (feels natural for catching up)
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);

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

        // One-way ratchet: only move forward (ignore backward jitter)
        // The ratchet only resets on track change (handled by resetting displayedProgress)
        if (targetProgress > ratchetedProgress) {
            ratchetedProgress = targetProgress;
        }

        // Smoothly interpolate toward ratcheted target
        const delta = ratchetedProgress - displayedProgress;
        if (delta > FORWARD_JUMP_THRESHOLD) {
            // Target jumped way ahead - ease into it quickly
            displayedProgress += delta * 0.3;
        } else if (delta > 0) {
            // Normal forward motion - smooth eased lerp
            const easedFactor = easeOut(SMOOTH_FACTOR) + SMOOTH_FACTOR;
            displayedProgress += delta * easedFactor;
        }
        // Never go backward (delta <= 0 is ignored)

        const progress = Math.min(1, Math.max(0, displayedProgress));
        renderProgressBar(progress);
        updatePlaybackClockDisplay();

        // Update OS media session position (Now Playing widget progress bar)
        if (navigator.mediaSession && safeDuration > 0) {
            const pos = progress * safeDuration;
            try {
                navigator.mediaSession.setPositionState({
                    duration: safeDuration,
                    position: Math.min(pos, safeDuration),
                    playbackRate: 1
                });
            } catch (_) { /* some browsers reject if duration/position are inconsistent */ }
        }

        // Auto-promote: if playlist tray is empty and <30s remain,
        // lock in the next track so it's queued for the imminent transition
        const remainingSeconds = safeDuration * (1 - progress);
        if (
            remainingSeconds <= LOCKOUT_THRESHOLD_SECONDS &&
            remainingSeconds > 0 &&
            !playlistHasItems() &&
            !state._autoPromoted &&
            typeof window.promoteCenterCardToTray === 'function'
        ) {
            state._autoPromoted = true;
            log.info(`🎵 Auto-promoting next track to playlist (${remainingSeconds.toFixed(0)}s remaining)`);
            window.promoteCenterCardToTray();
        }

        if (progress >= 1) {
            clearInterval(state.progressAnimation);
            state.progressAnimation = null;
            updatePlaybackClockDisplay(safeDuration);
            applyTailProgress(1);
            stopPlaybackClockTicker();
            log.debug('Progress animation completed', { safeDuration });
        }
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

    log.info('🛑 Stopped progress animation');
    clearPlaybackClock();
    stopPlaybackClockTicker();
    clearPendingProgressStart();
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    window.startProgressAnimation = startProgressAnimation;
    window.startProgressAnimationFromPosition = startProgressAnimationFromPosition;
    window.stopProgressAnimation = stopProgressAnimation;
    window.getVisualProgressFraction = getVisualProgressFraction;
    window.maybeApplyDeferredNextTrack = maybeApplyDeferredNextTrack;
    window.applyTailProgress = applyTailProgress;
    window.updateTailProgress = updateTailProgress;
    window.renderProgressBar = renderProgressBar;
    window.clearPendingProgressStart = clearPendingProgressStart;
    window.formatTimecode = formatTimecode;
    window.updatePlaybackClockDisplay = updatePlaybackClockDisplay;
    window.clearPlaybackClock = clearPlaybackClock;
}
