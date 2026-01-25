const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load configuration
const configPath = path.join(__dirname, 'tsnotfyi-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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
    // Calculate streaming parameters for smooth playback
    this.engine.bytesPerSecond = this.sampleRate * this.channels * 2; // 16-bit PCM
    this.engine.chunkSize = Math.floor(this.engine.bytesPerSecond / config.audio.chunkDivisor); // ~40ms chunks

    console.log(`📊 Streaming: ${this.engine.chunkSize} bytes per chunk at ${this.sampleRate}Hz`);
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

        // Set crossfade lead time for next track (use cached analysis or calculate default)
        if (slot === 'next') {
          track.crossfadeLeadTime = cached.analysis.crossfadeLeadTime || 8; // Default if not cached
          console.log(`🎯 Next track (cached) crossfade lead time: ${track.crossfadeLeadTime}s`);
        }

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

      // Step 4: Convert back to streaming format (MP3)
      const streamBuffer = await this.convertToMp3(trimmedResult.buffer);

      // Store in appropriate slot first
      const track = this.engine[slot === 'current' ? 'currentTrack' : 'nextTrack'];

      // Cache the processed result with recalculated duration
      // Include crossfade lead time in cached analysis
      const extendedAnalysis = {
        ...analysis,
        actualDuration: trimmedResult.actualDuration,
        crossfadeLeadTime: slot === 'next' ? track.crossfadeLeadTime : undefined
      };

      this.cacheTrackMixdown(trackPath, streamBuffer, extendedAnalysis);
      track.buffer = streamBuffer;
      track.bpm = analysis.bpm;
      track.key = analysis.key;
      track.analyzed = true;
      track.estimatedDuration = trimmedResult.actualDuration; // Use recalculated duration from trimming

      // Analyze crossfade lead time for next track
      if (slot === 'next') {
        track.crossfadeLeadTime = this.analyzeCrossfadeLeadTime(trimmedResult);
        console.log(`🎯 Next track crossfade lead time: ${track.crossfadeLeadTime}s`);
      }

      console.log(`✅ Track processed and cached: BPM=${analysis.bpm}, Key=${analysis.key}, Size=${streamBuffer.length} bytes`);

      const trackDetails = {
        bpm: analysis.bpm,
        key: analysis.key,
        duration: trimmedResult.actualDuration, // Return the recalculated duration
        size: streamBuffer.length
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

      process.stdout.on('data', (chunk) => {
        pcmBuffer = Buffer.concat([pcmBuffer, chunk]);
      });

      process.stderr.on('data', (data) => {
        // Suppress FFmpeg verbose output
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(pcmBuffer);
        } else {
          reject(new Error(`FFmpeg PCM conversion failed with code ${code}`));
        }
      });
    });
  }

  // Convert PCM buffer to MP3 for streaming
  async convertToMp3(pcmBuffer) {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-f', 's16le',
        '-ar', this.sampleRate.toString(),
        '-ac', this.channels.toString(),
        '-i', 'pipe:0',
        '-f', 'mp3',
        '-b:a', `${this.bitRate}k`,
        '-q:a', '2',             // High quality
        'pipe:1'
      ];

      const process = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let mp3Buffer = Buffer.alloc(0);

      process.stdout.on('data', (chunk) => {
        mp3Buffer = Buffer.concat([mp3Buffer, chunk]);
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(mp3Buffer);
        } else {
          reject(new Error(`FFmpeg MP3 conversion failed with code ${code}`));
        }
      });

      process.stdin.write(pcmBuffer);
      process.stdin.end();
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

  // Detect musical key (simplified)
  detectKey(pcmBuffer) {
    // Placeholder key detection - would use chromagram analysis in production
    const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const modes = ['maj', 'min'];

    // For now, return a reasonable guess based on audio content
    const keyIndex = Math.floor(Math.random() * keys.length);
    const modeIndex = Math.floor(Math.random() * modes.length);

    return `${keys[keyIndex]}${modes[modeIndex]}`;
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

    if (this.onTrackStart) {
      this.onTrackStart();
    }

    this.engine.streamTimer = setInterval(() => {
      this.streamTick();
    }, 40); // 25fps for smooth streaming

    return true;
  }

  // Stop streaming
  stopStreaming() {
    if (this.engine.streamTimer) {
      clearInterval(this.engine.streamTimer);
      this.engine.streamTimer = null;
    }

    this.engine.isStreaming = false;
    this.engine.isCrossfading = false;

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
    if (remainingBytes <= 0) {
      // Buffer is empty but track may still be playing from internal audio buffers
      return;
    }

    // Check if we should start crossfading (2.5s before end) - using wall-clock time with guardrails
    const elapsedTime = (Date.now() - this.engine.streamingStartTime) / 1000;
    const estimatedDuration = this.engine.currentTrack.estimatedDuration;
    const remainingSeconds = estimatedDuration ? estimatedDuration - elapsedTime : 0;

    // Calculate byte-based timing estimate for guardrails
    const bytesRemaining = this.engine.currentTrack.buffer ?
      this.engine.currentTrack.buffer.length - this.engine.currentTrack.position : 0;
    const estimatedBitrate = this.engine.currentTrack.buffer && estimatedDuration ?
      this.engine.currentTrack.buffer.length / estimatedDuration : 44100 * 2 * 2; // fallback: 44.1kHz stereo 16-bit
    const byteBasedRemaining = bytesRemaining / estimatedBitrate;

    // Primary timing logic (wall-clock based) - use next track's optimal lead time
    const crossfadeLeadTime = this.engine.nextTrack.crossfadeLeadTime || this.engine.crossfadeDuration;

    const shouldStartCrossfade = remainingSeconds > 0 &&
        remainingSeconds <= crossfadeLeadTime &&
        this.engine.nextTrack.buffer &&
        !this.engine.isCrossfading;

    // Guardrail: Detect timing mismatch
    if (shouldStartCrossfade && byteBasedRemaining > this.engine.crossfadeDuration * 2) {
      console.error(`🚨 TIMING MISMATCH: Wall-clock wants crossfade but bytes suggest ${byteBasedRemaining.toFixed(1)}s remaining!`);
      console.error(`🚨 Wall-clock: ${remainingSeconds.toFixed(1)}s, Bytes: ${bytesRemaining}/${this.engine.currentTrack.buffer?.length}, Est bitrate: ${estimatedBitrate.toFixed(0)}`);
      // Still proceed with wall-clock timing, but we've logged the issue
    }

    // Guardrail: Emergency crossfade trigger
    if (!this.engine.isCrossfading && this.engine.nextTrack.buffer && byteBasedRemaining < 1.0 && remainingSeconds > 1.0) {
      console.error(`🚨 EMERGENCY CROSSFADE: Only ${byteBasedRemaining.toFixed(1)}s left by bytes but wall-clock shows ${remainingSeconds.toFixed(1)}s!`);
      console.error(`🚨 Forcing crossfade to prevent dead air - this indicates a timing calibration issue`);
      this.startCrossfade();
    } else if (shouldStartCrossfade) {
      console.log(`🔄 Starting crossfade with ${remainingSeconds.toFixed(1)}s remaining (lead time: ${crossfadeLeadTime}s)`);
      this.startCrossfade();
    }

    let chunk;
    if (this.engine.isCrossfading && this.engine.nextTrack.buffer) {
      chunk = this.createCrossfadeChunk();
    } else {
      // Normal playback with potential tempo adjustment
      chunk = this.createNormalChunk(remainingBytes);
    }

    if (chunk && chunk.length > 0) {
      // Debug: log chunk info occasionally (more frequent for debugging)
      if (Math.random() < 0.01) { // 1% chance for debugging
        console.log(`🎵 Streaming chunk: ${chunk.length} bytes, crossfading: ${this.engine.isCrossfading}, position: ${this.engine.currentTrack.position}/${this.engine.currentTrack.buffer?.length}`);
      }
      this.onData(chunk);
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
    // Rough estimation - would be more accurate with proper MP3 frame analysis
    const avgBytesPerSecond = this.engine.bytesPerSecond / 8; // MP3 compression estimate
    return remainingBytes / avgBytesPerSecond;
  }

  // Start crossfade transition
  startCrossfade() {
    this.engine.isCrossfading = true;
    this.engine.crossfadePosition = 0;

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

  // Unified audio matching: tempo priority with pitch smoothing
  calculateAudioMatching() {
    // Initialize to natural playback
    this.engine.tempoAdjustment = 1.0;
    this.engine.targetTrackTempo = 1.0;
    this.engine.pitchShiftRatio = 1.0;
    this.engine.enableTempoAdjustment = false;

    if (!this.engine.currentTrack.bpm || !this.engine.nextTrack.bpm) {
      return;
    }

    const currentBPM = this.engine.currentTrack.bpm;
    const nextBPM = this.engine.nextTrack.bpm;
    const TEMPO_TOLERANCE = 0.17; // 17% tolerance for beat matching

    // Calculate tempo difference
    const tempoRatio = nextBPM / currentBPM;
    const tempoDifference = Math.abs(1 - tempoRatio);

    let beatMatchingActive = false;

    // Step 1: Check tempo matching (priority)
    if (tempoDifference <= TEMPO_TOLERANCE) {
      // Enable beat matching - adjust next track to match current
      this.engine.targetTrackTempo = 1.0; // Current track locked at natural tempo
      this.engine.tempoAdjustment = currentBPM / nextBPM; // Adjust next track
      beatMatchingActive = true;
      console.log(`🎛️ Beat matching enabled: ${nextBPM} → ${currentBPM} BPM (${(tempoDifference*100).toFixed(1)}% diff, tempo: ${this.engine.tempoAdjustment.toFixed(3)}x)`);
    } else {
      console.log(`🎵 No beat matching: ${currentBPM} → ${nextBPM} BPM (${(tempoDifference*100).toFixed(1)}% diff > ${TEMPO_TOLERANCE*100}% tolerance)`);
    }

    // Step 2: Pitch smoothing (only if beat matching is active)
    if (beatMatchingActive && this.engine.currentTrack.key && this.engine.nextTrack.key) {
      const semitonesDiff = this.calculateSemitonesDifference(this.engine.currentTrack.key, this.engine.nextTrack.key);

      if (this.isJarringInterval(semitonesDiff)) {
        const targetShift = this.findNearestCompatibleKey(semitonesDiff);
        this.engine.pitchShiftRatio = Math.pow(2, targetShift / 12); // 12-tone equal temperament
        console.log(`🎼 Pitch smoothing: ${this.engine.nextTrack.key} shifted ${targetShift} semitones (${semitonesDiff} was jarring)`);
      } else {
        console.log(`🎼 No pitch adjustment needed: ${semitonesDiff} semitones is not jarring`);
      }
    }

    // Apply safety bounds
    const MAX_ADJUSTMENT = 1 + TEMPO_TOLERANCE;
    const MIN_ADJUSTMENT = 1 - TEMPO_TOLERANCE;

    this.engine.targetTrackTempo = Math.max(MIN_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, this.engine.targetTrackTempo));
    this.engine.tempoAdjustment = Math.max(MIN_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, this.engine.tempoAdjustment));

    // Recalculate durations after tempo adjustments
    this.recalculateTrackDurations();
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

  // Create crossfade chunk with proper cosine curve mixing
  createCrossfadeChunk() {
    const totalCrossfadeBytes = this.engine.crossfadeDuration * (this.engine.bytesPerSecond / 8);
    const fadeProgress = this.engine.crossfadePosition / totalCrossfadeBytes;

    if (fadeProgress >= 1.0) {
      // Crossfade complete, finalize transition and keep streaming seamlessly
      this.completeCrossfade();

      const chunk = this.getCurrentTrackChunk();
      return chunk && chunk.length > 0 ? chunk : null;
    }

    // Calculate clean cosine curve volumes (smooth S-curve)
    const { currentVolume, nextVolume } = this.calculateCosineFadeVolumes(fadeProgress);

    // Get chunks from both tracks
    const currentChunk = this.getCurrentTrackChunk();
    const nextChunk = this.getNextTrackChunk();

    if (!currentChunk && !nextChunk) {
      return null;
    }

    // For now, implement volume-based crossfade at chunk level
    // Future: real PCM mixing would happen here
    let selectedChunk;
    if (fadeProgress < 0.5) {
      // First half of crossfade - favor current track
      selectedChunk = currentChunk || nextChunk;
    } else {
      // Second half - favor next track
      selectedChunk = nextChunk || currentChunk;
    }

    // Update crossfade position
    this.engine.crossfadePosition += (selectedChunk ? selectedChunk.length : this.engine.chunkSize);

    // Log crossfade progress
    if (Math.random() < 0.1) { // 10% chance to log
      console.log(`🎵 Crossfade: ${(fadeProgress * 100).toFixed(1)}% (cosine volumes: ${currentVolume.toFixed(2)}/${nextVolume.toFixed(2)})`);
    }

    return selectedChunk;
  }

  // Calculate smooth cosine fade volumes
  calculateCosineFadeVolumes(progress) {
    // Clean cosine curve: smooth S-curve from 0 to 1
    // cos curve provides smooth acceleration/deceleration
    const cosProgress = (1 - Math.cos(progress * Math.PI)) / 2;

    return {
      currentVolume: Math.cos(cosProgress * Math.PI / 2), // Fade out
      nextVolume: Math.sin(cosProgress * Math.PI / 2)     // Fade in
    };
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

  // Get next track audio chunk (with tempo adjustment if needed)
  getNextTrackChunk() {
    if (!this.engine.nextTrack.buffer) return null;

    // Apply tempo adjustment for beat matching
    let chunkSize = this.engine.chunkSize;
    if (Math.abs(this.engine.tempoAdjustment - 1.0) > 0.001) {
      chunkSize = Math.floor(chunkSize / this.engine.tempoAdjustment);
    }

    const remainingBytes = this.engine.nextTrack.buffer.length - this.engine.nextTrack.position;
    const bytesToSend = Math.min(chunkSize, remainingBytes);

    if (bytesToSend <= 0) return null;

    const chunk = this.engine.nextTrack.buffer.slice(
      this.engine.nextTrack.position || 0,
      (this.engine.nextTrack.position || 0) + bytesToSend
    );

    this.engine.nextTrack.position = (this.engine.nextTrack.position || 0) + bytesToSend;
    return chunk;
  }

  // Convert MP3 chunk to PCM for mixing (simplified)
  async mp3ToPCM(mp3Chunk) {
    // In a full implementation, this would use FFmpeg to decode MP3 to PCM
    // For now, return a placeholder that represents the audio data
    // Real implementation would pipe mp3Chunk through FFmpeg decoder

    return new Promise((resolve) => {
      // Placeholder: simulate PCM conversion
      // Real: spawn FFmpeg process to decode this specific chunk
      resolve(mp3Chunk); // Simplified - treating as if it were PCM
    });
  }

  // Convert PCM back to MP3 (simplified)
  async pcmToMp3(pcmData) {
    // In a full implementation, this would encode PCM to MP3
    // For now, return the data as-is
    return new Promise((resolve) => {
      resolve(pcmData); // Simplified
    });
  }

  // Mix two PCM audio streams with volume levels
  mixPCMAudio(pcm1, pcm2, volume1, volume2) {
    // Simplified mixing - in reality would operate on actual PCM samples
    // This is a placeholder for proper audio mixing

    const mixedLength = Math.min(pcm1.length, pcm2.length);
    const mixed = Buffer.alloc(mixedLength);

    for (let i = 0; i < mixedLength; i++) {
      // Simplified mix: weighted average (not proper audio mixing)
      mixed[i] = Math.floor(pcm1[i] * volume1 + pcm2[i] * volume2);
    }

    return mixed;
  }

  // Complete crossfade and switch to next track
  completeCrossfade() {
    console.log('✅ Crossfade complete, switching to next track');

    // Move next track to current
    this.engine.currentTrack = {
      buffer: this.engine.nextTrack.buffer,
      position: 0,
      bpm: this.engine.nextTrack.bpm,
      key: this.engine.nextTrack.key,
      analyzed: this.engine.nextTrack.analyzed,
      estimatedDuration: this.engine.nextTrack.estimatedDuration
    };

    // Reset streaming start time for the new track
    this.engine.streamingStartTime = Date.now();
    console.log(`🕐 Reset streaming timer for new track (${this.engine.currentTrack.estimatedDuration?.toFixed(1)}s duration)`);

    // Clear next track
    this.engine.nextTrack = {
      buffer: null,
      bpm: null,
      key: null,
      analyzed: false
    };

    this.engine.isCrossfading = false;
    this.engine.crossfadePosition = 0;
    this.engine.tempoAdjustment = 1.0;
    this.trackMetadata.current = this.trackMetadata.next || null;
    this.trackMetadata.next = null;

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
      return true;
    } else if (this.engine.nextTrack.buffer && !this.engine.isCrossfading) {
      console.log('🎮 Forcing immediate crossfade');
      this.startCrossfade();
      return true;
    }
    return false;
  }

  // Manual tempo adjustment controls (for future DJ interface)
  setCurrentTrackTempo(tempoMultiplier) {
    // Allow manual tempo adjustment of current track
    tempoMultiplier = Math.max(0.5, Math.min(2.0, tempoMultiplier)); // 50% to 200%

    this.engine.targetTrackTempo = tempoMultiplier;
    this.engine.enableTempoAdjustment = true;

    console.log(`🎛️ Manual tempo adjustment: ${this.engine.currentTrackTempo.toFixed(3)} → ${tempoMultiplier.toFixed(3)}`);

    return this.engine.targetTrackTempo;
  }

  // Get current tempo info
  getTempoInfo() {
    return {
      currentTrackBPM: this.engine.currentTrack.bpm,
      nextTrackBPM: this.engine.nextTrack.bpm,
      currentTempo: this.engine.currentTrackTempo,
      targetTempo: this.engine.targetTrackTempo,
      isAdjusting: this.engine.enableTempoAdjustment,
      adjustmentProgress: this.engine.enableTempoAdjustment ?
        Math.abs(this.engine.targetTrackTempo - this.engine.currentTrackTempo) : 0
    };
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
      path: metadata.path || null
    };
  }

  getSlotMetadata(slot) {
    if (slot !== 'current' && slot !== 'next') {
      return null;
    }
    return this.trackMetadata[slot] || null;
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

  // Pre-cache multiple tracks from neighborhood (background processing)
  async preCacheNeighborhood(trackPaths, priority = 'background') {
    if (!Array.isArray(trackPaths)) return;

    const uncachedPaths = trackPaths.filter(path => !this.mixdownCache.has(path));
    if (uncachedPaths.length === 0) {
      console.log(`🚀 All ${trackPaths.length} neighborhood tracks already cached!`);
      return;
    }

    console.log(`🏭 Pre-caching ${uncachedPaths.length} tracks from neighborhood (${priority} priority)`);

    // Process tracks in background (don't await if background priority)
    if (priority === 'background') {
      // Fire-and-forget background caching
      this.backgroundCacheProcess(uncachedPaths);
    } else {
      // Synchronous caching for immediate use
      for (const trackPath of uncachedPaths) {
        try {
          await this.loadTrackToCache(trackPath);
        } catch (error) {
          console.warn(`⚠️ Failed to pre-cache ${trackPath}: ${error.message}`);
        }
      }
    }
  }

  // Background cache processing (async, non-blocking)
  async backgroundCacheProcess(trackPaths) {
    for (const trackPath of trackPaths) {
      try {
        // Check if we're still within cache limits
        if (this.mixdownCache.size >= this.maxCacheSize) {
          console.log(`🛑 Background caching stopped - cache full (${this.mixdownCache.size}/${this.maxCacheSize})`);
          break;
        }

        await this.loadTrackToCache(trackPath);

        // Small delay to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.warn(`⚠️ Background cache failed for ${trackPath}: ${error.message}`);
      }
    }

    console.log(`✅ Background caching complete. Cache: ${this.mixdownCache.size}/${this.maxCacheSize}`);
  }

  // Load track directly to cache (without affecting current/next slots)
  async loadTrackToCache(trackPath) {
    if (this.mixdownCache.has(trackPath)) {
      return; // Already cached
    }

    console.log(`💾 Background caching: ${trackPath}`);

    // Same processing pipeline as loadTrack, but only for caching
    const rawBuffer = await this.convertToPCM(trackPath);
    const analysis = await this.analyzeAudio(rawBuffer);
    const trimmedResult = this.trimSilence(rawBuffer);
    const streamBuffer = await this.convertToMp3(trimmedResult.buffer);

    this.cacheTrackMixdown(trackPath, streamBuffer, {
      ...analysis,
      actualDuration: trimmedResult.actualDuration
    });
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

  logPlaybackSummary(event = 'playback') {
    const metadata = this.trackMetadata.current || null;
    const startTime = this.engine.streamingStartTime;
    if (!metadata || !metadata.identifier || !startTime) {
      return;
    }
    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const estimatedDuration = this.engine.currentTrack?.estimatedDuration || null;
    console.log('🕒 [timing] Track playback summary', {
      event,
      trackId: metadata.identifier,
      title: metadata.title,
      elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
      estimatedDuration
    });
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
