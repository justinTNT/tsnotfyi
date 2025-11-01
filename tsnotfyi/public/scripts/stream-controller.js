(function attachStreamController(global) {
  const DEFAULTS = {
    mimeType: 'audio/mpeg',
    maxBufferDuration: 45,
    log: null,
    onError: null
  };

  function logEvent(controller, level, message, extra) {
    const logger = controller.options.log;
    if (typeof logger === 'function') {
      try {
        logger({ level, message, ...extra });
      } catch (err) {
        console.warn('StreamController logger failed:', err);
      }
    }
  }

  class MediaStreamController {
    constructor(audioElement, options = {}) {
      if (!audioElement) {
        throw new Error('MediaStreamController requires an audio element');
      }
      this.audio = audioElement;
      this.options = { ...DEFAULTS, ...options };

      this.mediaSource = null;
      this.sourceBuffer = null;
      this.objectUrl = null;
      this.queue = [];
      this.reader = null;
      this.abortController = null;
      this.pendingUrl = null;
      this.started = false;
      this.lastCleanup = 0;

      this.onSourceOpen = this.onSourceOpen.bind(this);
      this.onSourceError = this.onSourceError.bind(this);
      this.onBufferUpdate = this.onBufferUpdate.bind(this);
      this.onBufferError = this.onBufferError.bind(this);
    }

    static isSupported() {
      if (typeof window === 'undefined') return false;
      const MediaSource = window.MediaSource || window.WebKitMediaSource;
      if (!MediaSource) return false;
      const mimeType = 'audio/mpeg';
      return typeof MediaSource.isTypeSupported === 'function'
        ? MediaSource.isTypeSupported(mimeType)
        : true;
    }

    start(streamUrl) {
      if (!streamUrl) {
        throw new Error('MediaStreamController.start requires a stream URL');
      }

      this.stop();
      this.started = true;
      this.pendingUrl = streamUrl;

      const MediaSourceCtor = window.MediaSource || window.WebKitMediaSource;
      this.mediaSource = new MediaSourceCtor();
      this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);
      this.mediaSource.addEventListener('error', this.onSourceError);

      try {
        this.objectUrl = URL.createObjectURL(this.mediaSource);
        this.audio.src = this.objectUrl;
        this.audio.load();
        logEvent(this, 'info', 'media_source_attached', { streamUrl });
      } catch (err) {
        logEvent(this, 'error', 'object_url_failed', { error: err?.message || err });
        this.handleFatalError(err);
        return;
      }
    }

    onSourceOpen() {
      if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
        return;
      }

      logEvent(this, 'info', 'media_source_open', {});
      this.mediaSource.duration = Infinity;

      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(this.options.mimeType);
      } catch (err) {
        logEvent(this, 'error', 'add_source_buffer_failed', { error: err?.message || err });
        this.handleFatalError(err);
        return;
      }

      this.sourceBuffer.mode = 'sequence';
      this.sourceBuffer.addEventListener('updateend', this.onBufferUpdate);
      this.sourceBuffer.addEventListener('error', this.onBufferError);

      this.startStreaming();
    }

    onSourceError(event) {
      logEvent(this, 'error', 'media_source_error', { error: event?.message || event });
      this.handleFatalError(new Error('MediaSource encountered an error'));
    }

    startStreaming() {
      if (!this.pendingUrl) {
        logEvent(this, 'warn', 'no_stream_url', {});
        return;
      }

      const controller = new AbortController();
      this.abortController = controller;

      fetch(this.pendingUrl, {
        signal: controller.signal,
        cache: 'no-store',
        mode: 'cors'
      }).then(response => {
        if (!response.ok || !response.body) {
          throw new Error(`Stream request failed with status ${response.status}`);
        }
        logEvent(this, 'info', 'stream_connected', { status: response.status });
        return response.body.getReader();
      }).then(reader => {
        this.reader = reader;
        return this.streamPump();
      }).catch(err => {
        if (controller.signal.aborted) {
          logEvent(this, 'info', 'stream_aborted', {});
          return;
        }
        logEvent(this, 'error', 'stream_fetch_failed', { error: err?.message || err });
        this.handleFatalError(err);
      });
    }

    async streamPump() {
      if (!this.reader) return;

      try {
        while (this.started) {
          const { done, value } = await this.reader.read();
          if (done) {
            logEvent(this, 'info', 'stream_complete', {});
            break;
          }

          if (value && value.length) {
            this.enqueue(new Uint8Array(value));
          }
        }
      } catch (err) {
        if (this.abortController?.signal.aborted) {
          logEvent(this, 'info', 'stream_pump_aborted', {});
          return;
        }
        logEvent(this, 'error', 'stream_pump_failed', { error: err?.message || err });
        this.handleFatalError(err);
      }
    }

    enqueue(chunk) {
      if (!this.sourceBuffer) {
        logEvent(this, 'warn', 'enqueue_without_source', {});
        return;
      }

      if (!(chunk instanceof Uint8Array)) {
        chunk = new Uint8Array(chunk);
      }

      if (this.sourceBuffer.updating || this.queue.length) {
        this.queue.push(chunk);
        return;
      }

      try {
        this.sourceBuffer.appendBuffer(chunk);
      } catch (err) {
        logEvent(this, 'error', 'append_failed', { error: err?.message || err });
        this.handleFatalError(err);
      }
    }

    onBufferUpdate() {
      if (!this.sourceBuffer || this.sourceBuffer.updating) {
        return;
      }

      if (this.queue.length) {
        const nextChunk = this.queue.shift();
        try {
          this.sourceBuffer.appendBuffer(nextChunk);
          return;
        } catch (err) {
          logEvent(this, 'error', 'append_failed_queue', { error: err?.message || err });
          this.handleFatalError(err);
          return;
        }
      }

      this.pruneBuffer();
    }

    onBufferError(event) {
      logEvent(this, 'error', 'source_buffer_error', { error: event?.message || event });
      this.handleFatalError(new Error('SourceBuffer error'));
    }

    pruneBuffer() {
      if (!this.sourceBuffer || this.sourceBuffer.updating) {
        return;
      }

      const maxDuration = this.options.maxBufferDuration;
      if (!Number.isFinite(maxDuration) || maxDuration <= 0) {
        return;
      }

      const buffered = this.audio.buffered;
      if (!buffered || buffered.length === 0) {
        return;
      }

      const currentTime = this.audio.currentTime || 0;
      const target = currentTime - maxDuration;
      if (target <= 0) {
        return;
      }

      const start = buffered.start(0);
      if (!Number.isFinite(start) || target <= start) {
        return;
      }

      const end = Math.min(buffered.end(buffered.length - 1), target);
      if (end <= start) {
        return;
      }

      try {
        this.sourceBuffer.remove(start, end);
      } catch (err) {
        logEvent(this, 'warn', 'buffer_prune_failed', { error: err?.message || err });
      }
    }

    handleFatalError(err) {
      if (this.options.onError) {
        try {
          this.options.onError(err);
        } catch (callbackError) {
          console.warn('StreamController onError failed:', callbackError);
        }
      }
      this.stop();
    }

    stop() {
      this.started = false;

      if (this.abortController) {
        try {
          this.abortController.abort();
        } catch (err) {
          logEvent(this, 'warn', 'abort_failed', { error: err?.message || err });
        }
      }

      if (this.reader) {
        try {
          this.reader.cancel();
        } catch (err) {
          logEvent(this, 'warn', 'reader_cancel_failed', { error: err?.message || err });
        }
      }

      this.abortController = null;
      this.reader = null;
      this.pendingUrl = null;
      this.queue.length = 0;

      if (this.sourceBuffer) {
        this.sourceBuffer.removeEventListener('updateend', this.onBufferUpdate);
        this.sourceBuffer.removeEventListener('error', this.onBufferError);
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          try {
            this.mediaSource.endOfStream();
          } catch (err) {
            logEvent(this, 'warn', 'end_of_stream_failed', { error: err?.message || err });
          }
        }
      }

      this.sourceBuffer = null;

      if (this.mediaSource) {
        this.mediaSource.removeEventListener('sourceopen', this.onSourceOpen);
        this.mediaSource.removeEventListener('error', this.onSourceError);
      }

      if (this.objectUrl) {
        try {
          URL.revokeObjectURL(this.objectUrl);
        } catch (err) {
          logEvent(this, 'warn', 'revoke_url_failed', { error: err?.message || err });
        }
      }

      this.objectUrl = null;
      this.mediaSource = null;
    }
  }

  global.MediaStreamController = MediaStreamController;
})(window);
