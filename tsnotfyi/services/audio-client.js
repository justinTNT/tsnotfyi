/**
 * AudioClient — HTTP client for the Audio server (port 3002).
 * Used by the Web server to delegate all mixer operations.
 */

const serverLogger = require('../server-logger');
const audioLog = serverLogger.createLogger('audio-client');

class AudioClient {
  constructor({ url = 'http://localhost:3002', timeoutMs = 15000 } = {}) {
    this._url = url.replace(/\/$/, '');
    this._timeoutMs = timeoutMs;
  }

  async _fetch(path, options = {}) {
    const url = `${this._url}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this._timeoutMs);

    try {
      const resp = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Audio ${options.method || 'GET'} ${path} returned ${resp.status}: ${body}`);
      }

      return resp.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async _post(path, body, options = {}) {
    return this._fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
      ...options
    });
  }

  async _delete(path, options = {}) {
    return this._fetch(path, { method: 'DELETE', ...options });
  }

  // ─── Health ─────────────────────────────────────────────────────────────────

  async health() {
    return this._fetch('/health');
  }

  async waitForReady(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const h = await this.health();
        if (h.status === 'ok') return true;
      } catch (e) {
        // Audio server not up yet
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  async createSession(sessionId, { autoStart = false, ephemeral = false } = {}) {
    return this._post('/internal/sessions', { sessionId, autoStart, ephemeral });
  }

  async destroySession(sessionId) {
    return this._delete(`/internal/sessions/${sessionId}`);
  }

  // ─── Playback Commands ─────────────────────────────────────────────────────

  async play(sessionId, track) {
    return this._post('/internal/play', { sessionId, track });
  }

  async nextTrack(sessionId, trackMd5, { direction, origin } = {}) {
    return this._post('/internal/next-track', { sessionId, trackMd5, direction, origin });
  }

  async forceNext(sessionId) {
    return this._post('/internal/force-next', { sessionId });
  }

  async setRecommendation(sessionId, recommendation) {
    return this._post('/internal/explorer-recommendation', { sessionId, recommendation });
  }

  // ─── State Queries ──────────────────────────────────────────────────────────

  async getMixerState(sessionId) {
    return this._fetch(`/internal/mixer-state/${sessionId}`);
  }

  async getFullState(sessionId) {
    return this._fetch(`/internal/sessions/${sessionId}/full-state`);
  }

  // ─── Command Dispatch ──────────────────────────────────────────────────────
  // General-purpose endpoint for less common mixer operations.

  async command(sessionId, action, params = {}) {
    return this._post(`/internal/sessions/${sessionId}/command`, { action, ...params });
  }

  // Convenience wrappers for common commands:

  async initializeSession(sessionId, type, name, stack) {
    return this.command(sessionId, 'initializeSession', { type, name, stack });
  }

  async resetForJourney(sessionId, track) {
    return this.command(sessionId, 'resetForJourney', { track });
  }

  async resetStack(sessionId) {
    return this.command(sessionId, 'resetStack');
  }

  async resetDrift(sessionId) {
    return this.command(sessionId, 'resetDrift');
  }

  async getStackState(sessionId) {
    return this.command(sessionId, 'getStackState');
  }

  async loadStackState(sessionId, state) {
    return this.command(sessionId, 'loadStackState', { state });
  }

  async jumpToStackPosition(sessionId, index, position) {
    return this.command(sessionId, 'jumpToStackPosition', { index, position });
  }

  async setResolution(sessionId, resolution) {
    return this.command(sessionId, 'setResolution', { resolution });
  }

  async broadcastHeartbeat(sessionId, reason, { force = false } = {}) {
    return this.command(sessionId, 'broadcastHeartbeat', { reason, force });
  }

  async broadcastSelection(sessionId, event, payload) {
    return this.command(sessionId, 'broadcastSelection', { event, payload });
  }

  async clearPendingSelection(sessionId) {
    return this.command(sessionId, 'clearPendingSelection');
  }

  async triggerDirectionalFlow(sessionId, direction) {
    return this.command(sessionId, 'triggerDirectionalFlow', { direction });
  }

  async updateMetadata(sessionId, metadata) {
    return this.command(sessionId, 'updateMetadata', { metadata });
  }

  async setOnIdle(sessionId, callbackUrl) {
    return this.command(sessionId, 'setOnIdle', { callbackUrl });
  }

  async selectNextTrack(sessionId, trackMd5, opts = {}) {
    return this.command(sessionId, 'selectNextTrack', { trackMd5, ...opts });
  }

  async hydrateTrack(sessionId, trackIdOrObj, annotations) {
    return this.command(sessionId, 'hydrateTrack', { track: trackIdOrObj, annotations });
  }

  async prepareNextCrossfade(sessionId, opts) {
    return this.command(sessionId, 'prepareNextCrossfade', opts);
  }

  async getExplorerData(sessionId, { trackId, forceFresh = false } = {}) {
    return this.command(sessionId, 'getExplorerData', { trackId, forceFresh });
  }

  async setClientBuffer(sessionId, clientBufferSecs) {
    return this.command(sessionId, 'setClientBuffer', { clientBufferSecs });
  }

  async startDriftPlayback(sessionId) {
    return this.command(sessionId, 'startDriftPlayback');
  }

  async getStats(sessionId) {
    return this.command(sessionId, 'getStats');
  }
}

module.exports = AudioClient;
