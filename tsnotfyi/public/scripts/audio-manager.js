// Audio Manager - handles audio streaming, health monitoring, and recovery
// Pipeline (HTTPS): fetch() → Int16→Float32 → postMessage → AudioWorkletProcessor → GainNode → destination
// Pipeline (HTTP):  fetch() → Int16→Float32 → main-thread ring buffer → ScriptProcessorNode → GainNode → destination
// Dependencies: globals.js (state, elements, connectionHealth, audioHealth, constants)

import {
  state,
  elements,
  connectionHealth,
  audioHealth,
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
import { createLogger } from './log.js';
const log = createLogger('audio');
const sentinelLog = createLogger('sentinel');

// Callbacks to be set by page.js - allows audio-manager to trigger page-level actions
const audioCallbacks = {
  connectSSE: null,
  startProgressAnimationFromPosition: null,
  clearPendingProgressStart: null,
  verifyExistingSessionOrRestart: null,
  createNewJourneySession: null,
  clearFingerprint: null,
  composeStreamEndpoint: null,
  fullResync: null,
  onSentinel: null
};

export function setAudioCallbacks(callbacks) {
  Object.assign(audioCallbacks, callbacks);
}

// ====== PCM Pipeline State ======

let audioContext = null;
let workletNode = null;
let gainNode = null;
let fetchAbortController = null;
let softwareClock = 0;
let pipelineStreamUrl = null;
let workletSampleRate = 44100; // actual rate reported by worklet, may differ from 44100
let workletBufferedFrames = 0; // last-reported buffer fill from worklet (for throttling)
let workletTotalSent = 0;      // total frames sent to worklet via postMessage

// ====== ScriptProcessorNode Fallback State ======

let scriptNode = null;
let useScriptProcessor = false;
let mtBuffer = null;         // main-thread ring buffer (Float32 interleaved stereo)
let mtBufferSize = 0;        // total float32 slots (frames × 2 channels)
let mtWritePos = 0;
let mtReadPos = 0;
let mtSamplesWritten = 0;    // frames written (includes overflow-discarded)
let mtSamplesPlayed = 0;     // frames consumed from buffer (includes overflow-skipped)
let mtFramesRendered = 0;    // frames actually sent to audio output (clock source)
let mtReadySent = false;
let mtUnderrunReported = false;
let mtHalfSecondFrames = 0;
let mtReadyThresholdFrames = 0;
let mtLastPositionReport = 0;

// ====== Sentinel Detection State ======

// All three sentinel patterns use only 0x7FFF and -32768 (0x8000) as Int16 values.
// We hold samples while we see only those two values. After 8 held samples, classify:
//   8× 0x7FFF                         → 'track-boundary'
//   4× [0x7FFF, -32768]               → 'crossfade-start'
//   4× [-32768, 0x7FFF]               → 'crossfade-end'
// If 8 held samples don't match any pattern, or a non-sentinel value arrives before 8,
// restore all held samples as real audio.

let sentinelHeldValues = [];        // Int16 values held pending sentinel classification
let sentinelPendingEvent = null;    // debounce: only one sentinel per microtask

const SENTINEL_VAL_MAX = 0x7FFF;    // 32767
const SENTINEL_VAL_MIN = -32768;    // 0x8000

function classifySentinel(held) {
  // held is an array of exactly 8 Int16 values
  // All three patterns use both 0x7FFF and -32768 to avoid false positives from clipped audio

  // track-boundary: first 4 = 0x7FFF, last 4 = -32768
  const firstFourMax = held[0] === SENTINEL_VAL_MAX && held[1] === SENTINEL_VAL_MAX &&
                       held[2] === SENTINEL_VAL_MAX && held[3] === SENTINEL_VAL_MAX;
  const lastFourMin = held[4] === SENTINEL_VAL_MIN && held[5] === SENTINEL_VAL_MIN &&
                      held[6] === SENTINEL_VAL_MIN && held[7] === SENTINEL_VAL_MIN;
  if (firstFourMax && lastFourMin) return 'track-boundary';

  // crossfade-start: alternating 0x7FFF, -32768 (starting with 0x7FFF)
  let isCrossfadeStart = true;
  let isCrossfadeEnd = true;
  for (let i = 0; i < 8; i++) {
    if (i % 2 === 0) {
      if (held[i] !== SENTINEL_VAL_MAX) isCrossfadeStart = false;
      if (held[i] !== SENTINEL_VAL_MIN) isCrossfadeEnd = false;
    } else {
      if (held[i] !== SENTINEL_VAL_MIN) isCrossfadeStart = false;
      if (held[i] !== SENTINEL_VAL_MAX) isCrossfadeEnd = false;
    }
  }
  if (isCrossfadeStart) return 'crossfade-start';
  if (isCrossfadeEnd) return 'crossfade-end';

  return null; // not a sentinel
}

function fireSentinel(type) {
  if (!sentinelPendingEvent) {
    sentinelPendingEvent = type;
    queueMicrotask(() => {
      const event = sentinelPendingEvent;
      sentinelPendingEvent = null;
      if (event) handlePipelineEvent({ type: 'sentinel', sentinel: event });
    });
  }
}

// ====== Int16 LE → Float32 Conversion ======

function isSentinelValue(int16) {
  return int16 === SENTINEL_VAL_MAX || int16 === SENTINEL_VAL_MIN;
}

function int16ToFloat32(uint8Array) {
  // uint8Array is raw bytes of Int16 LE PCM (stereo interleaved)
  const dataView = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
  const numSamples = Math.floor(uint8Array.byteLength / 2);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const int16 = dataView.getInt16(i * 2, true); // little-endian

    if (isSentinelValue(int16)) {
      sentinelHeldValues.push(int16);
      float32[i] = 0; // Hold as silence until classification

      if (sentinelHeldValues.length >= 8) {
        const type = classifySentinel(sentinelHeldValues);
        if (type) {
          // Confirmed sentinel — held samples stay zeroed
          fireSentinel(type);
        } else {
          // 8 sentinel-possible values but no pattern match — restore as audio
          const restoreCount = sentinelHeldValues.length;
          for (let j = 0; j < restoreCount && i - (restoreCount - 1 - j) >= 0; j++) {
            float32[i - (restoreCount - 1 - j)] = sentinelHeldValues[j] / 32768;
          }
        }
        sentinelHeldValues = [];
      }
    } else {
      if (sentinelHeldValues.length > 0) {
        // False alarm: non-sentinel value broke the run — restore held samples
        const restoreCount = sentinelHeldValues.length;
        for (let j = 0; j < restoreCount && i - (restoreCount - j) >= 0; j++) {
          float32[i - (restoreCount - j)] = sentinelHeldValues[j] / 32768;
        }
        sentinelHeldValues = [];
      }
      float32[i] = int16 / 32768;
    }
  }
  return float32;
}

// ====== Fetch + Decode Pump ======

async function fetchAndPump(streamUrl) {
  fetchAbortController = new AbortController();
  let isFirstChunk = true;
  let remainder = null; // leftover bytes carried across chunks for alignment
  let chunkCount = 0;
  let lastPumpLog = 0;
  let throttleCount = 0;
  let totalBytesRead = 0;

  try {
    const response = await fetch(streamUrl, { signal: fetchAbortController.signal });
    if (!response.ok) {
      throw new Error(`Stream fetch failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    log.info('Fetch pump started');

    while (true) {
      const readStart = Date.now();
      const { done, value } = await reader.read();
      const readMs = Date.now() - readStart;
      if (readMs > 2000) {
        log.warn(`pump: reader.read() blocked ${readMs}ms (server stall?)`);
      }
      if (done) {
        log.info('Stream ended');
        handleStreamEnd();
        break;
      }

      totalBytesRead += value.byteLength;
      let pcmBytes = value;

      // Strip 44-byte WAV header from first chunk
      if (isFirstChunk) {
        isFirstChunk = false;
        if (pcmBytes.byteLength > 44) {
          pcmBytes = pcmBytes.subarray(44);
        } else {
          // Partial or exact header — consume header bytes, carry remainder to next chunk
          // (44-byte header may span multiple reader chunks in theory)
          continue;
        }
      }

      // Prepend any leftover bytes from previous chunk
      if (remainder && remainder.byteLength > 0) {
        const merged = new Uint8Array(remainder.byteLength + pcmBytes.byteLength);
        merged.set(remainder);
        merged.set(pcmBytes, remainder.byteLength);
        pcmBytes = merged;
        remainder = null;
      }

      // Align to 4-byte stereo frame boundary (2 bytes × 2 channels)
      const tail = pcmBytes.byteLength % 4;
      if (tail !== 0) {
        remainder = pcmBytes.slice(pcmBytes.byteLength - tail);
        pcmBytes = pcmBytes.subarray(0, pcmBytes.byteLength - tail);
      }

      if (pcmBytes.byteLength === 0) continue;

      const floatData = int16ToFloat32(pcmBytes);
      const buffer = floatData.buffer;

      if (useScriptProcessor) {
        // Break large chunks into 1-second segments and throttle between each.
        // Network reader can return multi-MB chunks (24+ seconds of audio) during backlog,
        // which would overflow the 8-second ring buffer if enqueued all at once.
        const mtBufferCapacity = mtBufferSize / 2;
        const segmentSize = 44100 * 2; // 1 second of stereo float32 (frames * 2 channels)
        let offset = 0;
        while (offset < floatData.length) {
          // Throttle: wait if buffer is >75% full
          while ((mtSamplesWritten - mtSamplesPlayed) > mtBufferCapacity * 0.75) {
            throttleCount++;
            await new Promise(resolve => setTimeout(resolve, 50));
            if (!mtBuffer) return;
          }
          const end = Math.min(offset + segmentSize, floatData.length);
          const segment = offset === 0 && end === floatData.length
            ? floatData  // avoid copy if chunk fits in one segment
            : floatData.subarray(offset, end);
          enqueuePCMMainThread(segment);
          offset = end;
        }

        // Periodic pump diagnostics (every 5 seconds)
        const now = Date.now();
        if (now - lastPumpLog > 5000) {
          const fill = mtSamplesWritten - mtSamplesPlayed;
          const fillSec = (fill / 44100).toFixed(1);
          const capSec = (mtBufferCapacity / 44100).toFixed(1);
          const chunkSec = (floatData.length / 2 / 44100).toFixed(1);
          log.info(`pump: chunk#${chunkCount} ${(totalBytesRead/1024).toFixed(0)}KB (${chunkSec}s), buf=${fillSec}/${capSec}s (${(fill/mtBufferCapacity*100).toFixed(0)}%), throttled=${throttleCount}x`);
          lastPumpLog = now;
        }
      } else if (workletNode) {
        // Break large chunks into 1-second segments and throttle between each.
        const workletCapacity = (audioContext?.sampleRate || 44100) * 8;
        const segmentSize = 44100 * 2; // 1 second of stereo float32
        let offset = 0;
        while (offset < floatData.length) {
          // Throttle: estimate fill and wait if >75% full
          workletTotalSent += 0; // only count when actually sending below
          const estimatedFill = workletTotalSent - (softwareClock * workletSampleRate);
          if (estimatedFill > workletCapacity * 0.75) {
            while (true) {
              await new Promise(resolve => setTimeout(resolve, 50));
              if (!workletNode) return;
              const currentFill = workletTotalSent - (softwareClock * workletSampleRate);
              if (currentFill <= workletCapacity * 0.5) break;
            }
          }
          const end = Math.min(offset + segmentSize, floatData.length);
          const segment = floatData.subarray(offset, end);
          const segBuf = segment.buffer.slice(segment.byteOffset, segment.byteOffset + segment.byteLength);
          workletTotalSent += (end - offset) / 2;
          workletNode.port.postMessage({ type: 'pcm', data: segBuf }, [segBuf]);
          offset = end;
        }
      }

      // Yield to event loop periodically so onaudioprocess / worklet can fire
      chunkCount++;
      if (chunkCount % 20 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      log.info('Fetch aborted (teardown)');
      return;
    }
    log.error('Stream fetch error:', err);
    handleStreamError(err);
  }
}

function handleStreamEnd() {
  clearAudioLoadPending('stream-end');
  audioHealth.isHealthy = false;
  connectionHealth.audio.status = 'error';
  updateConnectionHealthUI();
  handleDeadAudioSession('stream-end');
}

function handleStreamError(err) {
  clearAudioLoadPending('error');
  audioHealth.isHealthy = false;
  connectionHealth.audio.status = 'error';
  updateConnectionHealthUI();
  handleDeadAudioSession('fetch-error');
}

// ====== ScriptProcessorNode Main-Thread Buffer ======

function enqueuePCMMainThread(floats) {
  const len = floats.length;
  const incomingFrames = len / 2;
  const mtBufferCapacity = mtBufferSize / 2; // max frames the buffer can hold
  const currentAvail = mtSamplesWritten - mtSamplesPlayed;

  // Overflow protection: if incoming data would exceed buffer capacity,
  // advance read pointer to discard oldest audio and make room.
  // This happens when the server has backlogged data (e.g., client connected
  // minutes after server started streaming).
  if (currentAvail + incomingFrames > mtBufferCapacity) {
    const overflow = (currentAvail + incomingFrames) - mtBufferCapacity;
    mtReadPos = (mtReadPos + overflow * 2) % mtBufferSize;
    mtSamplesPlayed += overflow;
  }

  for (let i = 0; i < len; i++) {
    mtBuffer[mtWritePos] = floats[i];
    mtWritePos = (mtWritePos + 1) % mtBufferSize;
  }
  mtSamplesWritten += incomingFrames;

  if (!mtReadySent) {
    const buffered = mtSamplesWritten - mtSamplesPlayed;
    if (buffered >= mtReadyThresholdFrames) {
      mtReadySent = true;
      handlePipelineEvent({ type: 'ready' });
    }
  }
  mtUnderrunReported = false;
}

function handleScriptProcessorAudio(e) {
  const left = e.outputBuffer.getChannelData(0);
  const right = e.outputBuffer.getChannelData(1);
  const frames = left.length;
  const available = mtSamplesWritten - mtSamplesPlayed;

  if (available < frames) {
    left.fill(0);
    right.fill(0);
    if (!mtUnderrunReported && mtReadySent) {
      mtUnderrunReported = true;
      handlePipelineEvent({ type: 'underrun', available, needed: frames });
    }
    return;
  }

  for (let i = 0; i < frames; i++) {
    left[i] = mtBuffer[mtReadPos];
    mtReadPos = (mtReadPos + 1) % mtBufferSize;
    right[i] = mtBuffer[mtReadPos];
    mtReadPos = (mtReadPos + 1) % mtBufferSize;
  }
  mtSamplesPlayed += frames;
  mtFramesRendered += frames;

  if (mtFramesRendered - mtLastPositionReport >= mtHalfSecondFrames) {
    mtLastPositionReport = mtFramesRendered;
    handlePipelineEvent({
      type: 'position',
      samplesPlayed: mtFramesRendered,
      bufferedFrames: mtSamplesWritten - mtSamplesPlayed,
      overflows: 0
    });
  }
}

// ====== Pipeline Event Handler ======

function handleWorkletMessage(e) {
  handlePipelineEvent(e.data);
}

function handlePipelineEvent(msg) {
  switch (msg.type) {
    case 'info': {
      // Worklet reports its actual sample rate
      workletSampleRate = msg.sampleRate;
      log.info(`Worklet sample rate: ${workletSampleRate} (requested: 44100, context: ${audioContext?.sampleRate})`);
      if (workletSampleRate !== 44100) {
        log.warn(`Sample rate mismatch: worklet running at ${workletSampleRate}, PCM data is 44100`);
      }
      break;
    }

    case 'position': {
      // Update software clock using actual worklet sample rate
      softwareClock = msg.samplesPlayed / workletSampleRate;
      workletBufferedFrames = msg.bufferedFrames || 0;

      if (msg.overflows > 0) {
        log.warn(`Ring buffer overflows: ${msg.overflows}`);
      }

      // Same logic as the old 'timeupdate' event
      audioHealth.lastTimeUpdate = Date.now();
      audioHealth.bufferingStarted = null;
      audioHealth.isHealthy = true;
      audioHealth.lastObservedTime = softwareClock;
      if (audioHealth.stallTimer) {
        clearTimeout(audioHealth.stallTimer);
        audioHealth.stallTimer = null;
      }
      connectionHealth.audio.status = 'connected';
      updateConnectionHealthUI();

      // Pending progress start (mirrors timeupdate handler)
      if (state.pendingProgressStart && audioCallbacks.clearPendingProgressStart && audioCallbacks.startProgressAnimationFromPosition) {
        const audioReady = audioContext?.state === 'running';
        if (audioReady && softwareClock > 0.05) {
          const pending = state.pendingProgressStart;
          audioCallbacks.clearPendingProgressStart();
          audioCallbacks.startProgressAnimationFromPosition(
            pending.durationSeconds,
            pending.startPositionSeconds,
            { ...pending.options, deferIfAudioIdle: false }
          );
        }
      }

      // Drift check (mirrors timeupdate handler)
      if (Number.isFinite(softwareClock) && Number.isFinite(state.audioTrackStartClock) && state.playbackDurationSeconds > 0) {
        const audioElapsed = Math.max(0, softwareClock - state.audioTrackStartClock);
        const visualElapsed = Math.max(0, (Date.now() - state.playbackStartTimestamp) / 1000);
        const drift = Math.abs(audioElapsed - visualElapsed);
        if (drift > 1.25 && audioCallbacks.startProgressAnimationFromPosition) {
          log.debug('Audio-driven resync', { softwareClock, audioElapsed, visualElapsed, drift });
          const trackId = state.latestCurrentTrack?.identifier || null;
          audioCallbacks.startProgressAnimationFromPosition(state.playbackDurationSeconds, audioElapsed, { resync: true, trackId });
        }
      }
      break;
    }

    case 'underrun': {
      log.info(`Audio buffer underrun (available: ${msg.available}, needed: ${msg.needed})`);
      audioHealth.bufferingStarted = Date.now();
      audioHealth.lastObservedTime = softwareClock;
      break;
    }

    case 'ready': {
      // Same as 'playing' handler
      log.info('Audio pipeline ready');
      clearAudioLoadPending('playing');
      audioHealth.bufferingStarted = null;
      audioHealth.lastTimeUpdate = Date.now();
      audioHealth.isHealthy = true;
      audioHealth.lastObservedTime = softwareClock;
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

      // Initial track timer (mirrors 'play' event handler)
      if (!state.pendingInitialTrackTimer) {
        state.pendingInitialTrackTimer = setTimeout(() => {
          const hasTrack = state.latestCurrentTrack && state.latestCurrentTrack.identifier;
          if (!hasTrack) {
            state.manualNextTrackOverride = false;
            state.skipTrayDemotionForTrack = null;
            state.manualNextDirectionKey = null;
            state.pendingManualTrackId = null;
            state.selectedIdentifier = null;
            state.stackIndex = 0;
            log.warn('ACTION initial-track-missing: no SSE track after 10s, requesting refresh');
            if (audioCallbacks.fullResync) {
              audioCallbacks.fullResync();
            }
          }
        }, 10000);
      }
      break;
    }

    case 'sentinel': {
      const sentinelType = msg.sentinel;
      const bufferDelay = getBufferDelaySecs();
      sentinelLog.info(`Sentinel detected: ${sentinelType} (buffer ahead: ${bufferDelay.toFixed(2)}s)`);
      if (audioCallbacks.onSentinel) {
        audioCallbacks.onSentinel(sentinelType, { bufferDelaySecs: bufferDelay });
      }
      break;
    }
  }
}

// ====== Pipeline Init / Teardown ======

export async function initPCMPipeline(streamUrl, ctx, options = {}) {
  audioContext = ctx;
  workletSampleRate = audioContext.sampleRate;
  useScriptProcessor = !!options.useScriptProcessor;

  const mode = useScriptProcessor ? 'ScriptProcessorNode' : 'AudioWorklet';
  log.info(`AudioContext created at ${audioContext.sampleRate} Hz (${mode} mode)`);

  // Create gain node for volume control
  gainNode = audioContext.createGain();
  gainNode.gain.value = elements.audio?.volume ?? 0.85;

  if (useScriptProcessor) {
    // Main-thread ring buffer: 8 seconds of stereo interleaved float32
    mtBufferSize = audioContext.sampleRate * 2 * 8;
    mtBuffer = new Float32Array(mtBufferSize);
    mtWritePos = 0;
    mtReadPos = 0;
    mtSamplesWritten = 0;
    mtSamplesPlayed = 0;
    mtFramesRendered = 0;
    mtReadySent = false;
    mtUnderrunReported = false;
    mtHalfSecondFrames = Math.floor(audioContext.sampleRate / 2);
    mtReadyThresholdFrames = audioContext.sampleRate * 3; // 3s buffer before triggering SSE
    mtLastPositionReport = 0;

    scriptNode = audioContext.createScriptProcessor(4096, 0, 2);
    scriptNode.onaudioprocess = handleScriptProcessorAudio;

    // Chain: scriptProcessor → gain → destination
    scriptNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
  } else {
    // AudioWorklet path
    workletNode = new AudioWorkletNode(audioContext, 'pcm-worklet-processor', {
      outputChannelCount: [2]
    });
    workletNode.port.onmessage = handleWorkletMessage;

    // Chain: worklet → gain → destination
    workletNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
  }

  pipelineStreamUrl = streamUrl;

  // Install the audio proxy
  installAudioProxy();

  // Start the fetch pump
  fetchAndPump(streamUrl);
}

export function teardownPipeline() {
  // Abort fetch
  if (fetchAbortController) {
    fetchAbortController.abort();
    fetchAbortController = null;
  }

  // Reset worklet buffer
  if (workletNode) {
    try {
      workletNode.port.postMessage({ type: 'reset' });
      workletNode.disconnect();
    } catch (e) { /* ignore */ }
    workletNode = null;
  }

  // Disconnect ScriptProcessorNode
  if (scriptNode) {
    try { scriptNode.disconnect(); } catch (e) { /* ignore */ }
    scriptNode = null;
  }

  if (gainNode) {
    try { gainNode.disconnect(); } catch (e) { /* ignore */ }
    gainNode = null;
  }

  if (audioContext) {
    try { audioContext.close(); } catch (e) { /* ignore */ }
    audioContext = null;
  }

  softwareClock = 0;
  pipelineStreamUrl = null;
  workletBufferedFrames = 0;
  workletTotalSent = 0;

  // Reset main-thread buffer state
  mtBuffer = null;
  mtBufferSize = 0;
  mtWritePos = 0;
  mtReadPos = 0;
  mtSamplesWritten = 0;
  mtSamplesPlayed = 0;
  mtFramesRendered = 0;
  mtReadySent = false;
  mtUnderrunReported = false;
  useScriptProcessor = false;
}

// ====== Audio Proxy ======

function installAudioProxy() {
  const previousVolume = (typeof elements.audio?.volume === 'number' && Number.isFinite(elements.audio.volume))
    ? elements.audio.volume : 0.85;

  elements.audio = {
    get currentTime() { return softwareClock; },
    get paused() { return audioContext?.state !== 'running'; },
    get readyState() { return (workletNode || scriptNode) ? 4 : 0; },
    get duration() { return Infinity; },
    get networkState() { return workletNode ? 2 : 0; },
    get error() { return null; },
    get currentSrc() { return pipelineStreamUrl || ''; },
    get src() { return pipelineStreamUrl || ''; },
    set src(v) {
      if (v) {
        connectAudioStream(v, { reason: 'proxy-src-set' });
      }
    },
    get buffered() { return { length: 0 }; },
    get playbackRate() { return 1; },

    get volume() { return gainNode?.gain.value ?? previousVolume; },
    set volume(v) {
      if (gainNode) gainNode.gain.value = Math.max(0, Math.min(1, v));
    },

    play() {
      if (audioContext?.state === 'suspended') {
        return audioContext.resume();
      }
      return Promise.resolve();
    },
    pause() {
      if (audioContext) audioContext.suspend();
    },
    load() { /* no-op */ },
    removeAttribute() { /* no-op */ },

    // Stubs for backward compat
    addEventListener() {},
    removeEventListener() {},
    cloneNode() { return this; },
    get parentElement() { return document.body; },
    get __driftHandlersAttached() { return true; },
    set __driftHandlersAttached(_v) { /* no-op */ },
  };

  // Sync gain to previous volume
  if (gainNode) gainNode.gain.value = previousVolume;
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
  log.info('Audio diagnostics', {
    label,
    paused: audioContext?.state !== 'running',
    readyState: workletNode ? 4 : 0,
    currentTime: Number.isFinite(softwareClock) ? Number(softwareClock.toFixed(3)) : null,
    pipelineActive: !!(workletNode || scriptNode),
    pipelineMode: useScriptProcessor ? 'ScriptProcessor' : 'AudioWorklet',
    audioContextState: audioContext?.state || 'closed',
    audioTrackStartClock: Number.isFinite(state.audioTrackStartClock) ? Number(state.audioTrackStartClock.toFixed(3)) : state.audioTrackStartClock,
    playbackStartTimestamp: state.playbackStartTimestamp,
    latestTrackId: state.latestCurrentTrack?.identifier || null,
    serverNextTrack: state.serverNextTrack || null,
    audioHealth: {
      isHealthy: audioHealth.isHealthy,
      lastTimeUpdate: audioHealth.lastTimeUpdate,
      bufferingStarted: audioHealth.bufferingStarted
    },
    ...extra
  });
}

/**
 * Returns how many seconds of audio are buffered ahead of playback.
 * Used to delay UI transitions so they align with what the listener hears.
 */
export function getBufferDelaySecs() {
  if (useScriptProcessor && mtBuffer) {
    const fill = mtSamplesWritten - mtSamplesPlayed;
    return fill / 44100;
  }
  // Worklet path: convert both to seconds to avoid sample-rate mismatch.
  // workletTotalSent counts 44100 Hz PCM frames; softwareClock is in seconds.
  if (workletNode) {
    const totalSentSecs = workletTotalSent / 44100;
    return Math.max(0, totalSentSecs - softwareClock);
  }
  return 0;
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
    log.error('Play retry exhausted', { reason, attempts: state.playRetryAttempts });
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
    log.info('Retrying audio play', { reason, attempt: attemptNumber });
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
        log.error(`Play failed (${reason}):`, err);
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
    log.error(`Play threw (${reason}):`, err);
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
  log.debug('Marked audio load pending', {
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
  log.debug('Clearing audio load pending', {
    status,
    elapsedMs: elapsed,
    reason: state.audioLoadReason,
    url: state.audioLoadUrl
  });
  state.audioLoadPending = false;
  state.audioLoadStartedAt = 0;
  state.audioLoadReason = null;
  state.audioLoadUrl = null;
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
  log.debug('Audio startup grace extended', {
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
    log.warn(`Connection quarantine engaged (${reason}) for ${Math.round(duration / 1000)}s`);
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
  log.info(`Connection quarantine cleared (${context})`);
}

// ====== Connect Audio Stream ======

export function connectAudioStream(streamUrl, { forceFallback = false, reason = 'initial' } = {}) {
  if (!streamUrl) {
    log.warn('connectAudioStream called without streamUrl');
    return false;
  }

  state.streamUrl = streamUrl;

  const activeLoadAge = state.audioLoadPending ? Date.now() - (state.audioLoadStartedAt || 0) : null;
  if (state.audioLoadPending && !forceFallback && activeLoadAge !== null && activeLoadAge < 5000) {
    log.warn('connectAudioStream skipped: load already pending', {
      ageMs: activeLoadAge,
      reason,
      pendingReason: state.audioLoadReason
    });
    return false;
  }

  // Teardown existing pipeline and restart
  teardownPipeline();
  softwareClock = 0;

  // Create fresh AudioContext and re-init pipeline
  const ctx = new AudioContext({ sampleRate: 44100 });

  const afterInit = () => {
    markAudioLoadPending(streamUrl, reason);
    if (!state.hasSuccessfulAudioStart) {
      extendAudioStartupGrace(reason);
    }
  };

  if (ctx.audioWorklet) {
    ctx.audioWorklet.addModule('scripts/pcm-worklet-processor.js').then(() => {
      initPCMPipeline(streamUrl, ctx);
      afterInit();
    }).catch(err => {
      log.error('Failed to load PCM worklet during connectAudioStream:', err);
      connectionHealth.audio.status = 'error';
      updateConnectionHealthUI();
    });
  } else {
    initPCMPipeline(streamUrl, ctx, { useScriptProcessor: true });
    afterInit();
  }

  return false;
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
    log.warn(`Auto audio rebuild triggered (${kind} x${threshold} in ${Math.round(windowMs / 1000)}s)`);
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
    log.error('Audio recovery via session rebind failed:', err);
  }

  try {
    if (audioCallbacks.createNewJourneySession) {
      await audioCallbacks.createNewJourneySession(`audio_dead_${reason}`);
      return true;
    }
  } catch (err) {
    log.error('Audio recovery via new session failed:', err);
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
    log.warn(`Audio restart suppressed (${Math.round(delay / 1000)}s of startup grace remaining)`);
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
    log.warn(`Connection quarantined (${state.connectionQuarantineReason || 'unknown'}); retrying audio restart in ${Math.round(delay / 1000)}s`);
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

  log.error('Audio session is dead - restarting application');
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

  // Teardown pipeline instead of pausing audio element
  teardownPipeline();
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
      log.warn('Failed to close SSE during restart:', err);
    }
    connectionHealth.currentEventSource = null;
  }

  (async () => {
    const recovered = await recoverAudioSession(reason);
    audioHealth.handlingRestart = false;

    if (!recovered) {
      log.error('Audio recovery failed; reloading page as last resort');
      window.location.reload();
      return;
    }

    log.info('Audio session recovery initiated; monitoring stream health');
    state.awaitingSSE = true;
    startAudioHealthMonitoring();
    if (audioCallbacks.connectSSE) {
      audioCallbacks.connectSSE();
    }
    if (elements.audio) {
      try {
        playAudioElement('audio-recovery');
      } catch (err) {
        log.warn('Failed to resume audio playback after recovery:', err);
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
  audioHealth.lastObservedTime = softwareClock;

  audioHealth.checkInterval = setInterval(() => {
    if (audioHealth.handlingRestart) {
      return;
    }

    const currentTime = softwareClock;
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
      log.error(`Audio session dead: no timeupdate for ${(timeSinceUpdate / 1000).toFixed(1)}s`);
      handleDeadAudioSession();
      return;
    }

    if (bufferingDuration > 8000) {
      log.warn(`Audio struggling: buffering for ${(bufferingDuration / 1000).toFixed(1)}s`);
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

// ====== Audio Event Listeners (no-op for worklet pipeline) ======

export function attachBaseAudioEventListeners(audioEl = elements.audio) {
  // No-op: worklet message handler replaces DOM audio events
}

// ====== Rebuild Audio Element ======

export function rebuildAudioElement(reason = 'unknown') {
  const previousVolume = (typeof elements.audio?.volume === 'number' && Number.isFinite(elements.audio.volume))
    ? elements.audio.volume : 0.85;

  log.info(`Rebuilding audio pipeline (${reason}), preserving volume=${previousVolume.toFixed(2)}`);

  teardownPipeline();

  state.audioElementVersion = (state.audioElementVersion || 1) + 1;
  state.audioElementRebuilds = (state.audioElementRebuilds || 0) + 1;

  if (state.isStarted && audioCallbacks.composeStreamEndpoint) {
    const streamUrl = audioCallbacks.composeStreamEndpoint(state.streamFingerprint, Date.now());
    const ctx = new AudioContext({ sampleRate: 44100 });

    const afterRebuild = () => {
      if (gainNode) gainNode.gain.value = previousVolume;
      clearPlayRetryTimer();
      playAudioElement(`rebuild-${reason}`);
    };

    if (ctx.audioWorklet) {
      ctx.audioWorklet.addModule('scripts/pcm-worklet-processor.js').then(() => {
        initPCMPipeline(streamUrl, ctx);
        afterRebuild();
      }).catch(err => {
        log.error('Failed to load PCM worklet during rebuild:', err);
        connectionHealth.audio.status = 'error';
        updateConnectionHealthUI();
      });
    } else {
      initPCMPipeline(streamUrl, ctx, { useScriptProcessor: true });
      afterRebuild();
    }
  }

  return true;
}

// ====== Initialization ======

export function initializeAudioManager() {
  // No-op: pipeline initialization happens in startAudio() via page.js
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
  window.recordAudioInstability = recordAudioInstability;
  window.handleDeadAudioSession = handleDeadAudioSession;
  window.startAudioHealthMonitoring = startAudioHealthMonitoring;
  window.attachBaseAudioEventListeners = attachBaseAudioEventListeners;
  window.rebuildAudioElement = rebuildAudioElement;
  window.initializeAudioManager = initializeAudioManager;
  window.initPCMPipeline = initPCMPipeline;
  window.teardownPipeline = teardownPipeline;
}
