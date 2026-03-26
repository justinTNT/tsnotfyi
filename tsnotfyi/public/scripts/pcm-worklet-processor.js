// PCM AudioWorklet Processor — receives raw Float32 PCM via postMessage,
// buffers in a ring buffer, and outputs stereo audio frames.

class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer: 24 seconds of stereo interleaved float32 at context sample rate
    // Must exceed server's aheadLimitMs (12s) by a comfortable margin to avoid overflows
    this._bufferSize = sampleRate * 2 * 24; // 24s × 2ch
    this._bufferCapacity = this._bufferSize / 2; // max frames the buffer can hold
    this._buffer = new Float32Array(this._bufferSize);
    this._writePos = 0;
    this._readPos = 0;
    this._samplesWritten = 0;
    this._samplesPlayed = 0;
    this._framesRendered = 0; // only real audio output, never overflow-advanced
    this._lastPositionReport = 0;
    this._readySent = false;
    this._underrunReported = false;
    this._overflowCount = 0;
    // Use half-second intervals for position reporting
    this._halfSecondFrames = Math.floor(sampleRate / 2);
    // Buffer 6 seconds before reporting ready — gives headroom for main-thread
    // SSE/explorer/render burst that happens immediately after ready fires
    this._readyThresholdFrames = sampleRate * 6;

    // Fade state: flush triggers fade-out, then fade-in on next data
    this._fadeOutRemaining = 0;
    this._fadeOutTotal = 0;
    this._fadeInRemaining = 0;
    this._fadeInTotal = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'pcm') {
        this._enqueuePCM(new Float32Array(e.data.data));
      } else if (e.data.type === 'reset') {
        this._writePos = 0;
        this._readPos = 0;
        this._samplesWritten = 0;
        this._samplesPlayed = 0;
        this._framesRendered = 0;
        this._readySent = false;
        this._underrunReported = false;
        this._overflowCount = 0;
      } else if (e.data.type === 'flush') {
        // Fade out over ~10ms (441 frames at 44100Hz), then clear
        const fadeFrames = Math.min(Math.floor(sampleRate * 0.01), this._available());
        if (fadeFrames > 0) {
          this._fadeOutRemaining = fadeFrames;
          this._fadeOutTotal = fadeFrames;
        } else {
          // Nothing to fade — just reset
          this._writePos = 0;
          this._readPos = 0;
          this._samplesWritten = 0;
          this._samplesPlayed = 0;
        }
      }
    };

    // Report the actual sample rate back to the main thread
    this.port.postMessage({ type: 'info', sampleRate: sampleRate });
  }

  _enqueuePCM(floats) {
    const len = floats.length;
    const incomingFrames = len / 2;
    const currentAvail = this._samplesWritten - this._samplesPlayed;

    // Overflow check: if incoming data would exceed buffer capacity, drop the incoming data.
    // Never advance the read pointer — that creates a hard cut (audible pop).
    // The server's aheadLimitMs (12s) should keep us within the 24s buffer.
    // If we overflow, something unusual happened (reconnect burst, main thread stall).
    if (currentAvail + incomingFrames > this._bufferCapacity) {
      this._overflowCount++;
      this.port.postMessage({
        type: 'overflow',
        dropped: incomingFrames,
        buffered: currentAvail,
        capacity: this._bufferCapacity,
        count: this._overflowCount
      });
      return; // drop this chunk — buffer is full, server is too far ahead
    }

    for (let i = 0; i < len; i++) {
      this._buffer[this._writePos] = floats[i];
      this._writePos = (this._writePos + 1) % this._bufferSize;
    }
    this._samplesWritten += incomingFrames;

    // Report ready when we have >= 3s buffered (survives main-thread startup burst)
    if (!this._readySent) {
      const bufferedFrames = this._samplesWritten - this._samplesPlayed;
      if (bufferedFrames >= this._readyThresholdFrames) {
        this._readySent = true;
        this.port.postMessage({ type: 'ready' });
      }
    }

    this._underrunReported = false;
  }

  _available() {
    return this._samplesWritten - this._samplesPlayed;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;

    const left = output[0];
    const right = output[1];
    const frames = left.length;

    const available = this._available();

    if (available < frames) {
      left.fill(0);
      right.fill(0);
      if (!this._underrunReported && this._readySent) {
        this._underrunReported = true;
        this.port.postMessage({ type: 'underrun', available, needed: frames });
      }
      return true;
    }

    for (let i = 0; i < frames; i++) {
      let l = this._buffer[this._readPos];
      this._readPos = (this._readPos + 1) % this._bufferSize;
      let r = this._buffer[this._readPos];
      this._readPos = (this._readPos + 1) % this._bufferSize;

      // Apply fade-in after flush
      if (this._fadeInRemaining > 0) {
        const gain = 1 - (this._fadeInRemaining / this._fadeInTotal);
        l *= gain;
        r *= gain;
        this._fadeInRemaining--;
      }

      // Apply fade-out during flush
      if (this._fadeOutRemaining > 0) {
        const gain = this._fadeOutRemaining / this._fadeOutTotal;
        l *= gain;
        r *= gain;
        this._fadeOutRemaining--;
        if (this._fadeOutRemaining === 0) {
          // Fade complete — clear the buffer, accept new data
          this._writePos = 0;
          this._readPos = 0;
          this._samplesWritten = 0;
          this._samplesPlayed = 0;
          this._readySent = false;
          // Arm fade-in for the next data
          const fadeInFrames = Math.floor(sampleRate * 0.01);
          this._fadeInRemaining = fadeInFrames;
          this._fadeInTotal = fadeInFrames;
          // Fill remaining output with silence
          for (let j = i + 1; j < frames; j++) {
            left[j] = 0;
            right[j] = 0;
          }
          this._framesRendered += i + 1;
          this.port.postMessage({ type: 'flushed' });
          return true;
        }
      }

      left[i] = l;
      right[i] = r;
    }
    this._samplesPlayed += frames;
    this._framesRendered += frames;

    // Report position every ~500ms (use framesRendered for clock, not overflow-inflated samplesPlayed)
    if (this._framesRendered - this._lastPositionReport >= this._halfSecondFrames) {
      this._lastPositionReport = this._framesRendered;
      this.port.postMessage({
        type: 'position',
        samplesPlayed: this._framesRendered,
        bufferedFrames: this._samplesWritten - this._samplesPlayed,
        overflows: this._overflowCount
      });
    }

    return true;
  }
}

registerProcessor('pcm-worklet-processor', PCMWorkletProcessor);
