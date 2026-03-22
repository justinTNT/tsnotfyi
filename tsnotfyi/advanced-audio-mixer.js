const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load configuration
const configPath = path.join(__dirname, 'tsnotfyi-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Sentinel patterns: 16-byte sequences injected into PCM stream for client-side event detection
// All patterns use both 0x7FFF and -32768 to avoid false positives from clipped audio
const SENTINEL_TRACK_BOUNDARY = Buffer.alloc(16);
for (let i = 0; i < 8; i += 2) SENTINEL_TRACK_BOUNDARY.writeInt16LE(0x7FFF, i);
for (let i = 8; i < 16; i += 2) SENTINEL_TRACK_BOUNDARY.writeInt16LE(-32768, i);

const SENTINEL_CROSSFADE_START = Buffer.alloc(16);
for (let i = 0; i < 16; i += 4) {
  SENTINEL_CROSSFADE_START.writeInt16LE(0x7FFF, i);
  SENTINEL_CROSSFADE_START.writeInt16LE(-32768, i + 2);
}

const SENTINEL_CROSSFADE_END = Buffer.alloc(16);
for (let i = 0; i < 16; i += 4) {
  SENTINEL_CROSSFADE_END.writeInt16LE(-32768, i);
  SENTINEL_CROSSFADE_END.writeInt16LE(0x7FFF, i + 2);
}

class AdvancedAudioMixer {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || config.audio.sampleRate;
    this.channels = options.channels || config.audio.channels;
    this.bitRate = options.bitRate || config.audio.bitRate;

    // Neighborhood mixdown cache - aggressive caching within current exploration area
    this.mixdownCache = new Map(); // trackPath -> { buffer, bpm, key, analysis, timestamp }
    this.maxCacheSize = config.cache.maxMixdownCacheSize;
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Audio engine state
    this.engine = {
      // Track buffers
      currentTrack: {
        buffer: null,
        position: 0,
        bpm: null,
        key: null,
        analyzed: false
      },
      nextTrack: {
        buffer: null,
        bpm: null,
        key: null,
        analyzed: false,
        crossfadeLeadTime: null // Seconds before track end to start crossfade (based on audio analysis)
      },

      // Mixing state
      isStreaming: false,
      isCrossfading: false,
      crossfadePosition: 0,
      crossfadeDuration: config.audio.crossfadeDuration,
      crossfadeStartTime: null, // When crossfade started (for stuck detection)
      crossfadeMaxWaitMs: 8000, // Max time to wait for next buffer during crossfade

      // Stream control
      streamTimer: null,
      chunkSize: null,
      bytesPerSecond: null,
      streamingStartTime: null, // Wall-clock time when streaming actually started

      // Audio processing
      silenceThreshold: config.audio.silenceThreshold,
      pitchShiftRatio: 1.0,
      tempoAdjustment: 1.0,

      // Real-time tempo adjustment for current track
      currentTrackTempo: 1.0, // Current playback speed multiplier
      targetTrackTempo: 1.0,  // Target speed for beat matching
      tempoTransitionRate: 0.02, // How quickly to adjust tempo (per frame)
      enableTempoAdjustment: false
    };

    this.calculateStreamingParams();

    // Event callbacks
    this.onData = null; // Callback for streaming audio chunks
    this.onTrackStart = null;
    this.onTrackEnd = null;
    this.onCrossfadeStart = null;
    this.onError = null;

    this.trackMetadata = {
      current: null,
      next: null
    };

    console.log('🎛️ Advanced Audio Mixer initialized');
  }

  calculateStreamingParams() {
    // Streaming raw PCM: sampleRate × channels × 2 bytes (16-bit)
    this.engine.bytesPerSecond = this.sampleRate * this.channels * 2;
    this.engine.tickMs = 200; // 5 ticks/sec nominal — actual pacing is clock-based, not interval-based
    this.engine.chunkSize = Math.floor(this.engine.bytesPerSecond * this.engine.tickMs / 1000);
    this.engine.aheadLimitMs = 12000; // max real-time lead over playback clock (burst ceiling)

    console.log(`📊 Streaming PCM: ${this.engine.chunkSize} bytes/chunk every ${this.engine.tickMs}ms (${this.sampleRate}Hz ${this.channels}ch 16-bit, ${Math.round(this.engine.bytesPerSecond / 1000)}kB/s)`);
  }

  // Load and process a track into the buffer with aggressive caching
  async loadTrack(trackPath, slot = 'current', metadata = null) {
    console.log(`🎵 Loading track: ${trackPath} into ${slot} slot`);

    try {
      // Check cache first
      const cached = this.mixdownCache.get(trackPath);
      if (cached) {
        this.cacheHits++;
        console.log(`🚀 Cache HIT for ${trackPath} (${this.cacheHits} hits, ${this.cacheMisses} misses)`);

        // Use cached data
        const track = this.engine[slot === 'current' ? 'currentTrack' : 'nextTrack'];
        track.buffer = cached.buffer;
        track.bpm = cached.bpm;
        track.key = cached.key;
        track.analyzed = true;
        track.estimatedDuration = cached.analysis.actualDuration || cached.analysis.duration; // Use recalculated duration

        // Set crossfade lead time (use cached analysis or default)
        track.crossfadeLeadTime = cached.analysis.crossfadeLeadTime || 8;
        console.log(`🎯 ${slot} track (cached) crossfade lead time: ${track.crossfadeLeadTime}s`);

        this.setSlotMetadata(slot, metadata);

        return {
          bpm: cached.bpm,
          key: cached.key,
          duration: cached.analysis.actualDuration || cached.analysis.duration, // Prefer recalculated duration
          size: cached.buffer.length
        };
      }

      // Cache miss - process the track
      this.cacheMisses++;
      console.log(`💾 Cache MISS for ${trackPath} - processing (${this.cacheHits} hits, ${this.cacheMisses} misses)`);

      // Step 1: Convert to raw PCM for analysis
      const rawBuffer = await this.convertToPCM(trackPath);

      // Step 2: Analyze audio characteristics
      const analysis = await this.analyzeAudio(rawBuffer);

      // Step 3: Trim silence and get actual duration
      const trimmedResult = this.trimSilence(rawBuffer);

      // Store trimmed PCM directly — no MP3 encoding, crossfade happens in PCM
      const track = this.engine[slot === 'current' ? 'currentTrack' : 'nextTrack'];

      const extendedAnalysis = {
        ...analysis,
        actualDuration: trimmedResult.actualDuration,
        crossfadeLeadTime: slot === 'next' ? track.crossfadeLeadTime : undefined
      };

      this.cacheTrackMixdown(trackPath, trimmedResult.buffer, extendedAnalysis);
      track.buffer = trimmedResult.buffer;
      track.bpm = analysis.bpm;
      track.key = analysis.key;
      track.analyzed = true;
      track.estimatedDuration = trimmedResult.actualDuration; // Use recalculated duration from trimming

      // Analyze quiet tail to determine when to start crossfading out of this track
      track.crossfadeLeadTime = this.analyzeCrossfadeLeadTime(trimmedResult);
      console.log(`🎯 ${slot} track crossfade lead time: ${track.crossfadeLeadTime}s`);

      console.log(`✅ Track processed and cached: BPM=${analysis.bpm}, Key=${analysis.key}, Size=${trimmedResult.buffer.length} bytes (PCM)`);

      const trackDetails = {
        bpm: analysis.bpm,
        key: analysis.key,
        duration: trimmedResult.actualDuration,
        size: trimmedResult.buffer.length
      };
      this.setSlotMetadata(slot, metadata);

      return trackDetails;

    } catch (error) {
      console.error(`❌ Failed to load track: ${error.message}`);
      throw error;
    }
  }

  // Cache processed mixdown with LRU eviction
  cacheTrackMixdown(trackPath, buffer, analysis) {
    // Implement LRU by removing oldest entries when cache is full
    if (this.mixdownCache.size >= this.maxCacheSize) {
      // Remove oldest entry (first key in Map maintains insertion order)
      const oldestKey = this.mixdownCache.keys().next().value;
      console.log(`🗑️ Evicting oldest cached track: ${oldestKey}`);
      this.mixdownCache.delete(oldestKey);
    }

    this.mixdownCache.set(trackPath, {
      buffer: buffer,
      bpm: analysis.bpm,
      key: analysis.key,
      analysis: analysis,
      timestamp: Date.now()
    });

    console.log(`💾 Cached mixdown: ${trackPath} (cache size: ${this.mixdownCache.size}/${this.maxCacheSize})`);
  }

  // Convert audio file to raw PCM for analysis
  async convertToPCM(inputPath) {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-i', inputPath,
        '-f', 's16le',           // 16-bit signed little-endian
        '-ar', this.sampleRate.toString(),
        '-ac', this.channels.toString(),
        '-vn',                   // No video
        'pipe:1'
      ];

      const process = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let pcmBuffer = Buffer.alloc(0);
      let stderrOutput = '';

      process.stdout.on('data', (chunk) => {
        pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
      });

      process.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(pcmBuffer);
        } else {
          const err = new Error(`FFmpeg PCM conversion failed with code ${code}`);
          // Detect file/volume not found for caller to handle
          if (stderrOutput.includes('No such file or directory')) {
            err.code = 'ENOENT';
            err.ffmpegDetail = 'file_not_found';
          }
          reject(err);
        }
      });
    });
  }

  // Analyze audio for BPM, key, and other characteristics
  async analyzeAudio(pcmBuffer) {
    console.log('🔬 Analyzing audio characteristics...');

    const analysis = {
      bpm: this.detectBPM(pcmBuffer),
      key: this.detectKey(pcmBuffer),
      duration: pcmBuffer.length / (this.sampleRate * this.channels * 2),
      rms: this.calculateRMS(pcmBuffer),
      peaks: this.findPeaks(pcmBuffer)
    };

    console.log(`📈 Analysis: BPM=${analysis.bpm}, Key=${analysis.key}, Duration=${analysis.duration.toFixed(1)}s`);

    return analysis;
  }

  // Simple BPM detection using autocorrelation
  detectBPM(pcmBuffer) {
    // Simplified BPM detection - in production, use proper beat detection
    // This analyzes tempo patterns in the audio

    const frameSize = this.channels * 2; // 16-bit stereo
    const frames = pcmBuffer.length / frameSize;
    const windowSize = Math.floor(this.sampleRate * 0.1); // 100ms windows
    const numWindows = Math.floor(frames / windowSize);

    let energyValues = [];

    // Calculate energy for each window
    for (let i = 0; i < numWindows; i++) {
      let energy = 0;
      const start = i * windowSize * frameSize;
      const end = Math.min(start + windowSize * frameSize, pcmBuffer.length);

      for (let j = start; j < end; j += frameSize) {
        // Average both channels
        const left = pcmBuffer.readInt16LE(j) / 32768.0;
        const right = pcmBuffer.readInt16LE(j + 2) / 32768.0;
        const sample = (left + right) / 2;
        energy += sample * sample;
      }

      energyValues.push(energy / windowSize);
    }

    // Find tempo using autocorrelation of energy
    let maxCorrelation = 0;
    let bestBPM = 120; // Default

    // Test BPM range from 60 to 180
    for (let testBPM = 60; testBPM <= 180; testBPM += 1) {
      const beatsPerSecond = testBPM / 60;
      const samplesPerBeat = this.sampleRate / beatsPerSecond;
      const windowsPerBeat = samplesPerBeat / windowSize;

      if (windowsPerBeat < 1 || windowsPerBeat > energyValues.length / 4) continue;

      let correlation = 0;
      let count = 0;

      for (let i = 0; i < energyValues.length - windowsPerBeat; i++) {
        correlation += energyValues[i] * energyValues[Math.floor(i + windowsPerBeat)];
        count++;
      }

      correlation /= count;

      if (correlation > maxCorrelation) {
        maxCorrelation = correlation;
        bestBPM = testBPM;
      }
    }

    return bestBPM;
  }

  // Key detection — noop for now, will implement chromagram analysis later
  detectKey(pcmBuffer) {
    return null;
  }

  // Calculate RMS energy
  calculateRMS(pcmBuffer) {
    const frameSize = this.channels * 2;
    const frames = pcmBuffer.length / frameSize;
    let sumSquares = 0;

    for (let i = 0; i < pcmBuffer.length; i += frameSize) {
      const left = pcmBuffer.readInt16LE(i) / 32768.0;
      const right = pcmBuffer.readInt16LE(i + 2) / 32768.0;
      const sample = (left + right) / 2;
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / frames);
  }

  // Find audio peaks for beat alignment
  findPeaks(pcmBuffer) {
    const frameSize = this.channels * 2;
    const windowSize = Math.floor(this.sampleRate * 0.05); // 50ms windows
    const numWindows = Math.floor((pcmBuffer.length / frameSize) / windowSize);
    const peaks = [];

    for (let i = 1; i < numWindows - 1; i++) {
      const start = i * windowSize * frameSize;
      const prevStart = (i - 1) * windowSize * frameSize;
      const nextStart = (i + 1) * windowSize * frameSize;

      const currentEnergy = this.getWindowEnergy(pcmBuffer, start, windowSize * frameSize);
      const prevEnergy = this.getWindowEnergy(pcmBuffer, prevStart, windowSize * frameSize);
      const nextEnergy = this.getWindowEnergy(pcmBuffer, nextStart, windowSize * frameSize);

      // Peak if current > both neighbors and above threshold
      if (currentEnergy > prevEnergy && currentEnergy > nextEnergy && currentEnergy > 0.1) {
        peaks.push({
          position: i * windowSize / this.sampleRate, // Time in seconds
          energy: currentEnergy
        });
      }
    }

    return peaks;
  }

  getWindowEnergy(buffer, start, length) {
    let energy = 0;
    const end = Math.min(start + length, buffer.length);

    for (let i = start; i < end; i += 4) { // 2 bytes per channel
      const left = buffer.readInt16LE(i) / 32768.0;
      const right = buffer.readInt16LE(i + 2) / 32768.0;
      const sample = (left + right) / 2;
      energy += sample * sample;
    }

    return energy / (length / 4);
  }

  // Trim silence from beginning and end
  trimSilence(pcmBuffer) {
    const frameSize = this.channels * 2;
    const totalFrames = pcmBuffer.length / frameSize;

    let startFrame = 0;
    let endFrame = totalFrames - 1;

    // Find start of audio
    for (let i = 0; i < totalFrames; i++) {
      const frameOffset = i * frameSize;
      let maxAmplitude = 0;

      for (let ch = 0; ch < this.channels; ch++) {
        const sampleOffset = frameOffset + (ch * 2);
        const sample = Math.abs(pcmBuffer.readInt16LE(sampleOffset) / 32768.0);
        maxAmplitude = Math.max(maxAmplitude, sample);
      }

      if (maxAmplitude > this.engine.silenceThreshold) {
        startFrame = i;
        break;
      }
    }

    // Find end of audio
    for (let i = totalFrames - 1; i >= startFrame; i--) {
      const frameOffset = i * frameSize;
      let maxAmplitude = 0;

      for (let ch = 0; ch < this.channels; ch++) {
        const sampleOffset = frameOffset + (ch * 2);
        const sample = Math.abs(pcmBuffer.readInt16LE(sampleOffset) / 32768.0);
        maxAmplitude = Math.max(maxAmplitude, sample);
      }

      if (maxAmplitude > this.engine.silenceThreshold) {
        endFrame = i;
        break;
      }
    }

    // Extract trimmed audio
    const trimmedFrames = endFrame - startFrame + 1;
    const trimmedLength = trimmedFrames * frameSize;
    const trimmedBuffer = Buffer.alloc(trimmedLength);

    pcmBuffer.copy(trimmedBuffer, 0, startFrame * frameSize, (endFrame + 1) * frameSize);

    const trimmedSeconds = (totalFrames - trimmedFrames) / this.sampleRate;
    const actualDurationSeconds = trimmedFrames / this.sampleRate;

    console.log(`✂️ Trimmed ${trimmedSeconds.toFixed(2)}s of silence`);
    console.log(`📏 Recalculated duration: ${actualDurationSeconds.toFixed(2)}s (was ${(totalFrames / this.sampleRate).toFixed(2)}s)`);

    return {
      buffer: trimmedBuffer,
      actualDuration: actualDurationSeconds
    };
  }

  // Start streaming current track
  startStreaming() {
    console.log('🔧 DEBUG: startStreaming() called');
    console.log(`🔧 DEBUG: engine.isStreaming = ${this.engine.isStreaming}`);
    console.log(`🔧 DEBUG: currentTrack.buffer exists = ${!!this.engine.currentTrack.buffer}`);
    console.log(`🔧 DEBUG: currentTrack.buffer length = ${this.engine.currentTrack.buffer?.length || 'null'}`);

    if (this.engine.isStreaming) {
      console.log('🔧 DEBUG: Already streaming - cannot start again');
      return false;
    }

    if (!this.engine.currentTrack.buffer) {
      console.log('🔧 DEBUG: No buffer available - cannot start streaming');
      return false;
    }

    if (this.engine.currentTrack.buffer.length === 0) {
      console.log('🔧 DEBUG: Empty buffer - cannot start streaming');
      return false;
    }

    console.log('🎵 Starting audio stream');
    this.engine.isStreaming = true;
    this.engine.currentTrack.position = 0;
    this.engine.streamingStartTime = Date.now(); // Track actual streaming start time
    if (this.onData) this.onData(SENTINEL_TRACK_BOUNDARY);

    if (this.onTrackStart) {
      this.onTrackStart();
    }

    // Clock-based streaming: burst to fill client buffer, then pace at 1x real-time.
    // If a tick is late, the next fires immediately to catch up — no accumulating drift.
    this.engine.bytesSent = 0;
    this.engine.streamClockStart = Date.now();
    const scheduleNext = () => {
      if (!this.engine.isStreaming) return;
      const elapsed = Date.now() - this.engine.streamClockStart;
      const bytesOwed = Math.floor((elapsed / 1000) * this.engine.bytesPerSecond);
      const ahead = this.engine.bytesSent - bytesOwed;
      const aheadMs = (ahead / this.engine.bytesPerSecond) * 1000;

      if (aheadMs < this.engine.aheadLimitMs) {
        // Under the ceiling — send a chunk now
        if (aheadMs < -5000 && Math.random() < 0.01) {
          console.warn(`⚠️ Stream clock drift: aheadMs=${aheadMs.toFixed(0)}, bytesSent=${this.engine.bytesSent}, bytesOwed=${bytesOwed}, elapsed=${elapsed}ms`);
        }
        const bytesBefore = this.engine.bytesSent;
        this.streamTick();

        // Safety: if streamTick didn't advance bytesSent, don't burst —
        // prevents tight spin loop when buffer is empty or chunk is null
        if (this.engine.bytesSent === bytesBefore) {
          this.engine.streamTimer = setTimeout(scheduleNext, this.engine.tickMs);
          return;
        }

        // If still under ceiling, schedule immediately (burst); otherwise wait
        const newAheadMs = ((this.engine.bytesSent - bytesOwed) / this.engine.bytesPerSecond) * 1000;
        this.engine.streamTimer = setTimeout(scheduleNext, newAheadMs >= this.engine.aheadLimitMs ? this.engine.tickMs : 0);
      } else {
        // At ceiling — wait for real-time to catch up
        this.engine.streamTimer = setTimeout(scheduleNext, this.engine.tickMs);
      }
    };
    scheduleNext();

    return true;
  }

  // Stop streaming
  stopStreaming() {
    if (this.engine.streamTimer) {
      clearTimeout(this.engine.streamTimer);
      this.engine.streamTimer = null;
    }
    if (this._deferredTrackStartTimer) {
      clearTimeout(this._deferredTrackStartTimer);
      this._deferredTrackStartTimer = null;
    }

    this.engine.isStreaming = false;
    this.engine.isCrossfading = false;
    this.engine.crossfadeStartTime = null;

    console.log('⏹️ Audio stream stopped');
  }

  // Stream tick - sends next chunk of audio with tempo adjustment
  streamTick() {
    if (!this.engine.currentTrack.buffer || !this.onData) {
      return;
    }

    // Skip processing if no clients are listening (avoid zombie streaming)
    if (this.hasClients && !this.hasClients()) {
      return; // Nobody listening - don't waste CPU
    }

    // Apply gradual tempo adjustment if enabled
    if (this.engine.enableTempoAdjustment) {
      this.updateCurrentTrackTempo();
    }

    const currentBuffer = this.engine.currentTrack.buffer;
    const position = this.engine.currentTrack.position;
    const remainingBytes = currentBuffer.length - position;

    // Check if track has actually finished playing (wall-clock time)
    if (this.engine.streamingStartTime && this.engine.currentTrack.estimatedDuration) {
      const elapsedTime = (Date.now() - this.engine.streamingStartTime) / 1000;
      if (elapsedTime >= this.engine.currentTrack.estimatedDuration) {
        console.log(`🏁 Track finished playing after ${elapsedTime.toFixed(1)}s (estimated: ${this.engine.currentTrack.estimatedDuration.toFixed(1)}s)`);
        this.handleTrackEnd();
        return;
      }
    }

    // Handle buffer depletion (but don't end track yet - audio may still be playing)
    // IMPORTANT: Don't return early if crossfading - we need to continue feeding next track chunks
    if (remainingBytes <= 0 && !this.engine.isCrossfading) {
      // Buffer is empty but track may still be playing from internal audio buffers
      return;
    }

    // Important: DO NOT rely on streamingStartTime (wall-clock) to determine crossfade triggers.
    // The server event loop and client buffer drains are too volatile.
    // ALWAYS trigger crossfades based purely on how many raw PCM bytes remain in the buffer.
    
    // Calculate byte-based timing estimate for crossfade triggers
    const bytesRemaining = this.engine.currentTrack.buffer ?
      this.engine.currentTrack.buffer.length - this.engine.currentTrack.position : 0;
      
    const estimatedSequenceSeconds = bytesRemaining / this.engine.bytesPerSecond;

    // Primary timing logic MUST be byte-based
    const crossfadeLeadTime = this.engine.currentTrack.crossfadeLeadTime || this.engine.crossfadeDuration;

    const shouldStartCrossfade = estimatedSequenceSeconds > 0 &&
        estimatedSequenceSeconds <= crossfadeLeadTime &&
        this.engine.nextTrack.buffer &&
        !this.engine.isCrossfading;

    // Guardrail: Report if we are spinning without the next buffer ready
    const isGettingLate = estimatedSequenceSeconds > 0 && 
                          estimatedSequenceSeconds <= crossfadeLeadTime &&
                          !this.engine.nextTrack.buffer &&
                          !this.engine.isCrossfading;
                          
    if (isGettingLate && Math.random() < 0.1) {
       console.warn(`⏳ Waiting for next track buffer! Only ${estimatedSequenceSeconds.toFixed(1)}s of PCM bytes left in current track.`);
    }

    if (shouldStartCrossfade && !this.isConsecutiveFolderTrack()) {
      console.log(`🔄 Starting crossfade with ${estimatedSequenceSeconds.toFixed(1)}s remaining (lead time: ${crossfadeLeadTime}s)`);
      this.startCrossfade();
    }

    let chunk;
    if (this.engine.isCrossfading && this.engine.nextTrack.buffer) {
      chunk = this.createCrossfadeChunk();
    } else if (this.engine.isCrossfading && !this.engine.nextTrack.buffer) {
      // Crossfade started but next buffer not ready - check for stuck state
      const crossfadeAge = this.engine.crossfadeStartTime
        ? Date.now() - this.engine.crossfadeStartTime
        : 0;

      if (crossfadeAge > this.engine.crossfadeMaxWaitMs) {
        console.error(`🚨 STUCK CROSSFADE: Waited ${crossfadeAge}ms for next buffer that never arrived`);
        console.error(`🚨 Canceling crossfade and continuing current track`);
        this.engine.isCrossfading = false;
        this.engine.crossfadePosition = 0;
        this.engine.crossfadeStartTime = null;
      }
      // Continue normal playback while waiting (or after cancel)
      chunk = this.createNormalChunk(remainingBytes);
    } else {
      // Normal playback with potential tempo adjustment
      chunk = this.createNormalChunk(remainingBytes);
    }

    if (chunk && chunk.length > 0) {
      this.engine.bytesSent = (this.engine.bytesSent || 0) + chunk.length;
      this.onData(chunk);
    }

    // Periodic stream health log (every ~30s)
    const now = Date.now();
    if (!this._lastStreamHealthLog || (now - this._lastStreamHealthLog) > 30000) {
      this._lastStreamHealthLog = now;
      const elapsed = now - (this.engine.streamClockStart || now);
      const bytesOwed = Math.floor((elapsed / 1000) * this.engine.bytesPerSecond);
      const ahead = (this.engine.bytesSent || 0) - bytesOwed;
      const aheadSecs = ahead / this.engine.bytesPerSecond;
      const bufferPosition = this.engine.currentTrack.position || 0;
      const bufferTotal = this.engine.currentTrack.buffer?.length || 0;
      const bufferRemainingSecs = (bufferTotal - bufferPosition) / this.engine.bytesPerSecond;
      console.log(JSON.stringify({
        _type: 'stream_health',
        ts: new Date().toISOString(),
        elapsedMs: elapsed,
        bytesSent: this.engine.bytesSent,
        bytesOwed,
        aheadSecs: +aheadSecs.toFixed(1),
        bufferPositionPct: bufferTotal > 0 ? +((bufferPosition / bufferTotal) * 100).toFixed(1) : 0,
        bufferRemainingSecs: +bufferRemainingSecs.toFixed(1),
        clientBufferSecs: this.clientBufferSecs ?? null,
        isCrossfading: this.engine.isCrossfading
      }));
    }
  }

  // Update current track tempo gradually
  updateCurrentTrackTempo() {
    const currentTempo = this.engine.currentTrackTempo;
    const targetTempo = this.engine.targetTrackTempo;
    const adjustmentRate = this.engine.tempoTransitionRate;

    if (Math.abs(targetTempo - currentTempo) < 0.001) {
      // Close enough, snap to target and disable adjustment
      this.engine.currentTrackTempo = targetTempo;
      this.engine.enableTempoAdjustment = false;
      console.log(`✅ Tempo adjustment complete: ${targetTempo.toFixed(3)}x`);
    } else {
      // Gradually adjust tempo
      const adjustment = (targetTempo - currentTempo) * adjustmentRate;
      this.engine.currentTrackTempo += adjustment;

      // Optional: log progress occasionally
      if (Math.random() < 0.01) { // 1% chance per tick
        console.log(`🎵 Tempo adjusting: ${this.engine.currentTrackTempo.toFixed(3)}x → ${targetTempo.toFixed(3)}x`);
      }
    }
  }

  // Create normal playback chunk with tempo adjustment
  createNormalChunk(remainingBytes) {
    const tempoMultiplier = this.engine.currentTrackTempo;

    if (Math.abs(tempoMultiplier - 1.0) < 0.001) {
      // No tempo adjustment needed - normal chunk
      const bytesToSend = Math.min(this.engine.chunkSize, remainingBytes);
      const chunk = this.engine.currentTrack.buffer.slice(
        this.engine.currentTrack.position,
        this.engine.currentTrack.position + bytesToSend
      );
      this.engine.currentTrack.position += bytesToSend;
      return chunk;
    }

    // Future implementation: Real-time tempo adjustment
    // For now, we'll adjust the chunk size to simulate tempo changes
    // This is a placeholder - real implementation would use FFmpeg filters or audio processing

    let adjustedChunkSize = Math.floor(this.engine.chunkSize / tempoMultiplier);
    const bytesToSend = Math.min(adjustedChunkSize, remainingBytes);

    const chunk = this.engine.currentTrack.buffer.slice(
      this.engine.currentTrack.position,
      this.engine.currentTrack.position + bytesToSend
    );

    this.engine.currentTrack.position += bytesToSend;

    // Note: This is a simplified implementation
    // Real tempo adjustment would require:
    // 1. Converting MP3 to PCM
    // 2. Applying time-stretching algorithms (PSOLA, WSOLA, or phase vocoder)
    // 3. Converting back to MP3
    // 4. Maintaining pitch while changing tempo

    return chunk;
  }

  // Estimate remaining playback time
  estimateRemainingTime(remainingBytes) {
    return remainingBytes / this.engine.bytesPerSecond;
  }

  // Check if current and next tracks are consecutive in the same folder (album continuity)
  isConsecutiveFolderTrack() {
    const current = this.trackMetadata.current;
    const next = this.trackMetadata.next;
    if (!current?.path || !next?.path) return false;

    const currentFolder = current.path.replace(/\/[^/]+$/, '');
    const nextFolder = next.path.replace(/\/[^/]+$/, '');
    if (currentFolder !== nextFolder) return false;

    const currentTrackNum = parseInt(current.track);
    const nextTrackNum = parseInt(next.track);
    if (!Number.isFinite(currentTrackNum) || !Number.isFinite(nextTrackNum)) return false;

    // Same disc (or both null) and consecutive track numbers
    const samedisc = (current.disc || 1) === (next.disc || 1);
    return samedisc && nextTrackNum === currentTrackNum + 1;
  }

  // Start crossfade transition
  startCrossfade() {
    if (this.onData) this.onData(SENTINEL_CROSSFADE_START);
    this.engine.isCrossfading = true;
    this.engine.crossfadePosition = 0;
    this.engine.crossfadeStartTime = Date.now();

    // Initialize next track position if not set
    if (!this.engine.nextTrack.position) {
      this.engine.nextTrack.position = 0;
    }

    // Calculate BPM matching
    this.calculateAudioMatching();

    console.log(`🎵 Starting 2.5s cosine crossfade: ${this.engine.currentTrack.bpm} BPM → ${this.engine.nextTrack.bpm} BPM`);

    if (this.onCrossfadeStart) {
      this.onCrossfadeStart({
        currentBPM: this.engine.currentTrack.bpm,
        nextBPM: this.engine.nextTrack.bpm,
        tempoAdjustment: this.engine.tempoAdjustment,
        duration: this.engine.crossfadeDuration
      });
    }
  }

  // Audio matching — noop for now, will implement tempo/key matching later
  calculateAudioMatching() {
    this.engine.tempoAdjustment = 1.0;
    this.engine.targetTrackTempo = 1.0;
    this.engine.pitchShiftRatio = 1.0;
    this.engine.enableTempoAdjustment = false;

    if (this.engine.currentTrack.bpm && this.engine.nextTrack.bpm) {
      console.log(`🎵 Crossfading: ${this.engine.currentTrack.bpm} BPM → ${this.engine.nextTrack.bpm} BPM (tempo/key matching disabled)`);
    }
  }

  // Calculate semitone difference between two keys
  calculateSemitonesDifference(key1, key2) {
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Extract root notes (ignore maj/min for now)
    const root1 = key1.replace(/maj|min/g, '');
    const root2 = key2.replace(/maj|min/g, '');

    const index1 = notes.indexOf(root1);
    const index2 = notes.indexOf(root2);

    if (index1 === -1 || index2 === -1) return 0; // Invalid keys

    // Calculate shortest distance on circle of fifths
    let diff = index2 - index1;
    if (diff > 6) diff -= 12;
    if (diff < -6) diff += 12;

    return diff;
  }

  // Check if interval is jarring during crossfades
  isJarringInterval(semitones) {
    const absInterval = Math.abs(semitones);
    return absInterval === 1 || absInterval === 2 || absInterval === 6; // Adjacent keys and tritone
  }

  // Find nearest compatible key (0, ±3, ±7 semitones)
  findNearestCompatibleKey(currentDiff) {
    const compatibleIntervals = [0, 3, -3, 7, -7];
    let bestShift = 0;
    let minDistance = Math.abs(currentDiff);

    for (const target of compatibleIntervals) {
      const shiftNeeded = target - currentDiff;
      const distance = Math.abs(shiftNeeded);
      if (distance < minDistance) {
        minDistance = distance;
        bestShift = shiftNeeded;
      }
    }

    return bestShift;
  }

  // Recalculate track durations after tempo/pitch adjustments
  recalculateTrackDurations() {
    // Current track - should remain at original duration (locked tempo)
    // No recalculation needed since targetTrackTempo is always 1.0

    // Next track - adjust duration based on tempo and pitch changes
    if (this.engine.nextTrack.estimatedDuration) {
      const originalDuration = this.engine.nextTrack.estimatedDuration;

      // Apply tempo adjustment (slower tempo = longer duration)
      const tempoAdjustedDuration = originalDuration / this.engine.tempoAdjustment;

      // Pitch shift has minimal effect on duration (negligible for small shifts)
      // Only adjust if pitch shift is significant
      const pitchDurationFactor = this.engine.pitchShiftRatio > 1 ?
        1.0 / Math.pow(this.engine.pitchShiftRatio, 0.1) : // Slight duration increase for pitch up
        Math.pow(this.engine.pitchShiftRatio, 0.1); // Slight duration decrease for pitch down

      const finalDuration = tempoAdjustedDuration * pitchDurationFactor;

      if (Math.abs(finalDuration - originalDuration) > 0.1) { // Only update if change > 0.1s
        this.engine.nextTrack.estimatedDuration = finalDuration;
        console.log(`📏 Next track duration adjusted: ${originalDuration.toFixed(1)}s → ${finalDuration.toFixed(1)}s (tempo: ${this.engine.tempoAdjustment.toFixed(3)}x, pitch: ${this.engine.pitchShiftRatio.toFixed(3)}x)`);
      }
    }
  }

  // Create crossfade chunk with per-sample cosine curve mixing.
  // Every sample gets its own fade coefficient — the volume curve is continuous,
  // not stepped at chunk boundaries.
  createCrossfadeChunk() {
    const totalCrossfadeSamples = this.engine.crossfadeDuration * this.sampleRate;
    const crossfadeSamplePos = this.engine.crossfadePosition; // in samples (not bytes)

    if (crossfadeSamplePos >= totalCrossfadeSamples) {
      this.completeCrossfade();
      if (this.onData) this.onData(SENTINEL_CROSSFADE_END);
      const chunk = this.getCurrentTrackChunk();
      return chunk && chunk.length > 0 ? chunk : null;
    }

    // Get raw PCM chunks from both tracks
    const currentChunk = this.getCurrentTrackChunk();
    const nextChunk = this.getNextTrackChunk();

    if (!currentChunk && !nextChunk) {
      return null;
    }

    // Per-sample mixing with continuous cosine curve
    const frameSize = this.channels * 2; // bytes per frame (stereo 16-bit = 4)
    const mixLength = currentChunk && nextChunk
      ? Math.min(currentChunk.length, nextChunk.length)
      : (currentChunk || nextChunk).length;
    const alignedLength = mixLength & ~(frameSize - 1); // align to frame boundary
    const mixed = Buffer.alloc(alignedLength);
    const framesInChunk = alignedLength / frameSize;

    for (let f = 0; f < framesInChunk; f++) {
      // Per-sample fade position (continuous)
      const sampleProgress = (crossfadeSamplePos + f) / totalCrossfadeSamples;
      const clampedProgress = Math.min(sampleProgress, 1.0);

      // Equal-power cosine crossfade: sum of squares ≈ 1.0 at all points
      const outGain = Math.cos(clampedProgress * Math.PI * 0.5);
      const inGain = Math.sin(clampedProgress * Math.PI * 0.5);

      const byteOffset = f * frameSize;
      for (let ch = 0; ch < this.channels; ch++) {
        const sampleOffset = byteOffset + ch * 2;
        const s1 = currentChunk ? currentChunk.readInt16LE(sampleOffset) : 0;
        const s2 = nextChunk ? nextChunk.readInt16LE(sampleOffset) : 0;
        const out = Math.round(s1 * outGain + s2 * inGain);
        mixed.writeInt16LE(Math.max(-32768, Math.min(32767, out)), sampleOffset);
      }
    }

    // Advance crossfade position in samples
    this.engine.crossfadePosition += framesInChunk;

    // Log crossfade progress occasionally
    const pct = (crossfadeSamplePos / totalCrossfadeSamples) * 100;
    if (Math.random() < 0.05) {
      console.log(`🎵 Crossfade: ${pct.toFixed(1)}% (per-sample cosine, ${framesInChunk} frames)`);
    }

    return mixed;
  }

  // Get current track audio chunk
  getCurrentTrackChunk() {
    if (!this.engine.currentTrack.buffer) return null;

    const remainingBytes = this.engine.currentTrack.buffer.length - this.engine.currentTrack.position;
    const bytesToSend = Math.min(this.engine.chunkSize, remainingBytes);

    if (bytesToSend <= 0) return null;

    const chunk = this.engine.currentTrack.buffer.slice(
      this.engine.currentTrack.position,
      this.engine.currentTrack.position + bytesToSend
    );

    this.engine.currentTrack.position += bytesToSend;
    return chunk;
  }

  // Get next track audio chunk
  getNextTrackChunk() {
    if (!this.engine.nextTrack.buffer) return null;

    const position = this.engine.nextTrack.position || 0;
    const remainingBytes = this.engine.nextTrack.buffer.length - position;
    const bytesToSend = Math.min(this.engine.chunkSize, remainingBytes);

    if (bytesToSend <= 0) return null;

    const chunk = this.engine.nextTrack.buffer.slice(position, position + bytesToSend);
    this.engine.nextTrack.position = position + bytesToSend;
    return chunk;
  }

  // Mix two PCM audio streams with volume levels
  mixPCMAudio(pcm1, pcm2, volume1, volume2) {
    // Mix two 16-bit signed PCM buffers with volume scaling
    // Each sample is 2 bytes (Int16LE), so step by 2
    const mixedLength = Math.min(pcm1.length, pcm2.length);
    // Ensure even length (aligned to sample boundary)
    const alignedLength = mixedLength & ~1;
    const mixed = Buffer.alloc(alignedLength);

    for (let i = 0; i < alignedLength; i += 2) {
      const sample1 = pcm1.readInt16LE(i);
      const sample2 = pcm2.readInt16LE(i);
      const mixedSample = Math.round(sample1 * volume1 + sample2 * volume2);
      // Clamp to Int16 range
      mixed.writeInt16LE(Math.max(-32768, Math.min(32767, mixedSample)), i);
    }

    return mixed;
  }

  // Apply volume to a 16-bit signed PCM buffer
  applyVolume(pcmBuffer, volume) {
    if (volume >= 0.999) return pcmBuffer; // No-op for full volume
    const alignedLength = pcmBuffer.length & ~1;
    const result = Buffer.alloc(alignedLength);

    for (let i = 0; i < alignedLength; i += 2) {
      const sample = pcmBuffer.readInt16LE(i);
      const scaled = Math.round(sample * volume);
      result.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i);
    }

    return result;
  }

  // Complete crossfade and switch to next track
  completeCrossfade() {
    console.log('✅ Crossfade complete, switching to next track');

    // Move next track to current — preserve read position and lead time from crossfade
    this.engine.currentTrack = {
      buffer: this.engine.nextTrack.buffer,
      position: this.engine.nextTrack.position || 0,
      bpm: this.engine.nextTrack.bpm,
      key: this.engine.nextTrack.key,
      analyzed: this.engine.nextTrack.analyzed,
      estimatedDuration: this.engine.nextTrack.estimatedDuration,
      crossfadeLeadTime: this.engine.nextTrack.crossfadeLeadTime
    };

    // Capture buffer-ahead BEFORE resetting clocks.
    // Use the smaller of server estimate and client-reported buffer depth —
    // prevents the broadcast from arriving after the audio transition.
    const preResetElapsed = Date.now() - (this.engine.streamClockStart || Date.now());
    const preResetBytesOwed = Math.floor((preResetElapsed / 1000) * this.engine.bytesPerSecond);
    const preResetAheadBytes = (this.engine.bytesSent || 0) - preResetBytesOwed;
    const serverAheadMs = Math.max(0, (preResetAheadBytes / this.engine.bytesPerSecond) * 1000);
    const clientAheadMs = Number.isFinite(this.clientBufferSecs) ? this.clientBufferSecs * 1000 : Infinity;
    const bufferAheadMs = Math.min(serverAheadMs, clientAheadMs);

    // Reset streaming clocks for the new track.
    // Set bytesSent to match the ahead limit so the scheduler starts in steady-state pacing,
    // not burst mode. The client already has buffered audio from the crossfade overlap.
    this.engine.streamingStartTime = Date.now();
    this.engine.streamClockStart = Date.now();
    this.engine.bytesSent = Math.floor((this.engine.aheadLimitMs / 1000) * this.engine.bytesPerSecond);
    console.log(JSON.stringify({
      _type: 'stream_clock_reset',
      ts: new Date().toISOString(),
      trackDuration: this.engine.currentTrack.estimatedDuration,
      bufferLength: this.engine.currentTrack.buffer?.length || 0,
      positionCarried: this.engine.currentTrack.position,
      bytesSentReset: this.engine.bytesSent,
      preResetElapsedMs: preResetElapsed,
      preResetBytesSent: this.engine.bytesSent,
      preResetBytesOwed: preResetBytesOwed,
      serverAheadMs: Math.round(serverAheadMs),
      clientAheadMs: clientAheadMs === Infinity ? 'no-report' : Math.round(clientAheadMs),
      clientBufferSecs: this.clientBufferSecs,
      chunkSize: this.engine.chunkSize,
      bytesPerSecond: this.engine.bytesPerSecond
    }));

    // Clear next track
    this.engine.nextTrack = {
      buffer: null,
      bpm: null,
      key: null,
      analyzed: false
    };

    this.engine.isCrossfading = false;
    this.engine.crossfadePosition = 0;
    this.engine.crossfadeStartTime = null;
    this.engine.tempoAdjustment = 1.0;
    console.log(JSON.stringify({
      _type: 'metadata_promotion',
      ts: new Date().toISOString(),
      fromNext: this.trackMetadata.next ? { id: this.trackMetadata.next.identifier, title: this.trackMetadata.next.title } : null,
      previousCurrent: this.trackMetadata.current ? { id: this.trackMetadata.current.identifier, title: this.trackMetadata.current.title } : null
    }));
    this.trackMetadata.current = this.trackMetadata.next || null;
    this.trackMetadata.next = null;

    // Fire onTrackStart immediately — no server-side deferral.
    // The client uses sentinels (in the audio stream) as the source of truth
    // for track changes, with a buffer-aware heartbeat fallback.
    if (this.onTrackStart) {
      this.onTrackStart('crossfade_complete');
    }
  }

  // Handle track end
  handleTrackEnd() {
    console.log('🏁 Track ended');

    if (this.onTrackEnd) {
      this.onTrackEnd();
    }

    if (this.engine.nextTrack.buffer) {
      this.completeCrossfade();
      if (this.onData) this.onData(SENTINEL_CROSSFADE_END);
      return;
    }

    this.stopStreaming();
  }

  // Force immediate transition (for testing)
  forceTransition(mode = 'crossfade') {
    if (mode === 'cut' && this.engine.nextTrack.buffer) {
      // Abrupt cut - no crossfade
      console.log('🎮 Forcing immediate CUT');
      this.completeCrossfade();
      if (this.onData) this.onData(SENTINEL_CROSSFADE_END);
      return true;
    } else if (this.engine.nextTrack.buffer && !this.engine.isCrossfading) {
      console.log('🎮 Forcing immediate crossfade');
      this.startCrossfade();
      return true;
    }
    return false;
  }

  // Clear mixdown cache (called on neighborhood transitions)
  clearMixdownCache() {
    const cacheSize = this.mixdownCache.size;
    this.mixdownCache.clear();
    console.log(`🧹 Cleared mixdown cache (${cacheSize} entries) - exploring new neighborhood`);

    // Reset cache stats for new neighborhood
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  clearNextTrackSlot() {
    const hadBuffer = !!this.engine.nextTrack.buffer;
    if (hadBuffer) {
      console.log('🧹 Clearing preloaded next track buffer');
    }

    this.engine.nextTrack = {
      buffer: null,
      position: 0,
      bpm: null,
      key: null,
      analyzed: false,
      estimatedDuration: null,
      crossfadeLeadTime: null
    };

    this.trackMetadata.next = null;
  }

  setSlotMetadata(slot, metadata) {
    if (slot !== 'current' && slot !== 'next') {
      return;
    }
    if (!metadata) {
      this.trackMetadata[slot] = null;
      return;
    }
    this.trackMetadata[slot] = {
      identifier: metadata.identifier || null,
      title: metadata.title || null,
      artist: metadata.artist || null,
      album: metadata.album || null,
      path: metadata.path || null,
      track: metadata.track || metadata.trackNumber || null,
      disc: metadata.disc || metadata.discNumber || null
    };
  }

  getCurrentPlaybackMetadata() {
    return this.trackMetadata.current || null;
  }

  // Get cache efficiency stats
  getCacheStats() {
    const total = this.cacheHits + this.cacheMisses;
    const hitRate = total > 0 ? (this.cacheHits / total * 100).toFixed(1) : '0.0';

    return {
      size: this.mixdownCache.size,
      maxSize: this.maxCacheSize,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: `${hitRate}%`,
      cachedTracks: Array.from(this.mixdownCache.keys())
        .filter(path => path && typeof path === 'string')
        .map(path => path.split('/').pop())
    };
  }

  // Get current mixer status
  getStatus() {
    return {
      isStreaming: this.engine.isStreaming,
      isCrossfading: this.engine.isCrossfading,
      currentTrack: {
        loaded: !!this.engine.currentTrack.buffer,
        position: this.engine.currentTrack.position,
        bpm: this.engine.currentTrack.bpm,
        key: this.engine.currentTrack.key,
        estimatedDuration: this.engine.currentTrack.estimatedDuration
      },
      nextTrack: {
        loaded: !!this.engine.nextTrack.buffer,
        bpm: this.engine.nextTrack.bpm,
        key: this.engine.nextTrack.key
      },
      crossfade: {
        progress: this.engine.crossfadePosition,
        duration: this.engine.crossfadeDuration,
        tempoAdjustment: this.engine.tempoAdjustment
      },
      cache: this.getCacheStats()
    };
  }

  // Analyze audio buffer to determine optimal crossfade lead time
  analyzeCrossfadeLeadTime(audioBuffer, sampleRate = 44100) {
    if (!audioBuffer || audioBuffer.length === 0) return 8; // Default fallback

    const channelData = this.extractMonoChannel(audioBuffer);
    const duration = channelData.length / sampleRate;

    // Calculate RMS energy for different ending windows
    const windows = [4, 8, 16, 32];
    const energyThreshold = 0.25; // 25% of peak energy

    // Find peak energy across entire track
    const peakEnergy = this.calculatePeakRMS(channelData, sampleRate);

    for (const windowSize of windows) {
      if (duration < windowSize + 2) continue; // Need at least 2s buffer

      const startSample = Math.max(0, channelData.length - (windowSize * sampleRate));
      const endingEnergy = this.calculateRMSFromFloat(channelData, startSample, windowSize * sampleRate);

      const energyRatio = endingEnergy / peakEnergy;
      console.log(`📊 Last ${windowSize}s: energy=${energyRatio.toFixed(3)} (${energyRatio < energyThreshold ? 'QUIET' : 'ACTIVE'})`);

      if (energyRatio < energyThreshold) {
        // Found quiet ending - use this window for crossfade lead time
        // Add 1s buffer for beat alignment (future enhancement)
        const leadTime = windowSize + 1;
        console.log(`✅ Crossfade lead time: ${leadTime}s (quiet ending detected)`);
        return leadTime;
      }
    }

    // No quiet ending found - use default with shorter lead time
    console.log(`⚡ Active ending - using short crossfade lead time: 6s`);
    return 6;
  }

  // Extract mono channel from potentially multi-channel buffer
  extractMonoChannel(audioBuffer) {
    if (audioBuffer.length === 0) return new Float32Array(0);

    // Assume stereo PCM - take every other sample for left channel
    const monoLength = Math.floor(audioBuffer.length / 4); // 2 channels × 2 bytes per sample
    const channelData = new Float32Array(monoLength);

    for (let i = 0; i < monoLength; i++) {
      // Convert 16-bit PCM to float (-1 to 1)
      const sampleIndex = i * 4; // Skip to next left channel sample
      const sample = audioBuffer.readInt16LE(sampleIndex) / 32768;
      channelData[i] = sample;
    }

    return channelData;
  }

  // Calculate RMS energy for a window (overloaded for Float32Array)
  calculateRMSFromFloat(channelData, startSample, numSamples) {
    const endSample = Math.min(startSample + numSamples, channelData.length);
    let sumSquares = 0;

    for (let i = startSample; i < endSample; i++) {
      sumSquares += channelData[i] * channelData[i];
    }

    return Math.sqrt(sumSquares / (endSample - startSample));
  }

  // Calculate peak RMS energy across entire track
  calculatePeakRMS(channelData, sampleRate, windowSize = 1024) {
    let maxRMS = 0;
    const hopSize = windowSize / 2;

    for (let i = 0; i < channelData.length - windowSize; i += hopSize) {
      const rms = this.calculateRMSFromFloat(channelData, i, windowSize);
      maxRMS = Math.max(maxRMS, rms);
    }

    return maxRMS;
  }

  // Clean up resources
  destroy() {
    console.log('🧹 Destroying advanced audio mixer');
    this.stopStreaming();

    // Clear cache
    this.mixdownCache.clear();

    this.engine.currentTrack.buffer = null;
    this.engine.nextTrack.buffer = null;

    this.onData = null;
    this.onTrackStart = null;
    this.onTrackEnd = null;
    this.onCrossfadeStart = null;
    this.onError = null;
  }
}

module.exports = AdvancedAudioMixer;
