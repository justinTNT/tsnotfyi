// SSE Manager — session resolution for SSE connections
// In split mode, browser connects directly to Audio server for /events and /stream.
// This manager handles session resolution and returns connection info.

const serverLogger = require('../server-logger');
const sseLog = serverLogger.createLogger('sse');
const { buildRequestContext, extractRequestIp } = require('./session-manager');

class SSEManager {
  constructor({ sessionManager, fingerprintRegistry, persistAudioSessionBinding, audioClient, audioServerUrl }) {
    this._sessionManager = sessionManager;
    this._fingerprintRegistry = fingerprintRegistry;
    this._persistAudioSessionBinding = persistAudioSessionBinding;
    this._audioClient = audioClient;
    this._audioServerUrl = audioServerUrl || 'http://localhost:3002';
  }

  registerRoutes(app) {
    app.get('/events', (req, res) => this.handleSSEConnection(req, res));
    app.get('/events/:sessionId', (req, res) => {
      sseLog.warn(`⚠️ Deprecated SSE URL requested: /events/${req.params.sessionId}`);
      res.status(410).json({ error: 'Session-specific SSE URLs have been removed. Connect to /events instead.' });
    });
    app.post('/refresh-sse', (req, res) => this.handleRefresh(req, res));
    app.post('/refresh-sse-simple', (req, res) => this.handleSimpleRefresh(req, res));
  }

  // ─── Session Resolution (shared logic) ────────────────────────────────────

  async _resolveSession(req, { createIfMissing = true } = {}) {
    const clientIp = extractRequestIp(req);
    const sm = this._sessionManager;
    const persistBinding = (sessionId) => this._persistAudioSessionBinding(req, sessionId);
    const ctx = buildRequestContext(req, { persistBinding });

    let session = await sm.getSessionForContext(ctx, { createIfMissing: false });
    let resolution = session ? 'context' : null;

    // Check Audio server for existing active sessions
    if (!session) {
      try {
        const health = await this._audioClient.health();
        if (health.sessions && health.sessions.length > 0) {
          const active = health.sessions.find(s => s.isActive || s.audioClients > 0);
          if (active) {
            session = sm.getSessionById(active.sessionId);
            if (session) resolution = 'existing_active';
          }
        }
      } catch (e) { /* ignore */ }
    }

    // Last healthy session fallback
    if (!session && clientIp) {
      const fallbackId = sm.lastHealthySessionByIp.get(clientIp);
      if (fallbackId) {
        session = sm.getSessionById(fallbackId);
        if (session) {
          resolution = 'last_healthy';
        } else {
          sm.lastHealthySessionByIp.delete(clientIp);
        }
      }
    }

    // Create if missing
    if (!session && createIfMissing) {
      session = await sm.getSessionForContext(ctx, { createIfMissing: false });
      if (!session) {
        session = await sm.createSession({ autoStart: false });
        sm.registerSession(session.sessionId, session);
      }
      resolution = resolution || 'fallback_create';
    }

    // Verify session exists on Audio server — recreate if stale
    if (session) {
      await sm.ensureAudioSession(session);
      session.lastAccess = new Date();
      await this._persistAudioSessionBinding(req, session.sessionId);
      if (clientIp) {
        session.lastMetadataIp = clientIp;
        sm.lastHealthySessionByIp.set(clientIp, session.sessionId);
      }
    }

    return { session, resolution, clientIp };
  }

  // ─── GET /events ────────────────────────────────────────────────────────────
  // Proxy SSE from Audio server to browser, preserving session resolution logic.

  async handleSSEConnection(req, res) {
    sseLog.info('📡 SSE connection attempt');

    try {
      const { session, resolution, clientIp } = await this._resolveSession(req);

      if (!session) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write('data: {"type":"error","message":"session_unavailable"}\n\n');
        return res.end();
      }

      const activeFingerprint = this._fingerprintRegistry.ensureFingerprint(
        session.sessionId,
        { trackId: null, startTime: Date.now(), metadataIp: clientIp }
      );

      const sm = this._sessionManager;
      sm.logSessionEvent('sse_client_connected', {
        sessionId: session.sessionId,
        fingerprint: activeFingerprint || null,
        ip: clientIp,
        resolution
      });

      // Proxy SSE from Audio server
      const audioEventsUrl = `${this._audioServerUrl}/events?sessionId=${session.sessionId}`;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      // Send connected event with session info
      res.write(`data: ${JSON.stringify({
        type: 'connected',
        sessionId: session.sessionId,
        fingerprint: activeFingerprint || null
      })}\n\n`);

      // Pipe SSE from Audio server to client
      const controller = new AbortController();
      fetch(audioEventsUrl, { signal: controller.signal })
        .then(async (audioRes) => {
          if (!audioRes.ok) {
            res.write('data: {"type":"error","message":"audio_server_unavailable"}\n\n');
            res.end();
            return;
          }

          const reader = audioRes.body.getReader();
          const decoder = new TextDecoder();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              // Skip the Audio server's own "connected" event
              if (!chunk.includes('"type":"connected"')) {
                res.write(chunk);
              }
            }
          } catch (e) {
            // Stream ended
          }
        })
        .catch((e) => {
          if (e.name !== 'AbortError') {
            sseLog.error('SSE proxy error:', e.message);
          }
        });

      req.on('close', () => {
        controller.abort();
      });

    } catch (error) {
      sseLog.error('📡 SSE connection error:', error);
      try {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"error","message":"connection_failed"}\n\n');
        res.end();
      } catch (err) {
        // Ignore secondary failure
      }
    }
  }

  // ─── POST /refresh-sse ──────────────────────────────────────────────────────

  async handleRefresh(req, res) {
    const stageParam = typeof req.body.stage === 'string' ? req.body.stage.trim().toLowerCase() : null;
    const stage = ['session', 'restart', 'rebroadcast'].includes(stageParam) ? stageParam : 'rebroadcast';

    const sm = this._sessionManager;

    try {
      const { session } = await this._resolveSession(req, { createIfMissing: stage === 'session' });

      if (!session && stage !== 'session') {
        return res.status(404).json({ error: 'Session not found' });
      }

      if (stage === 'session') {
        if (!session) {
          const newSession = await sm.createSession({ autoStart: true });
          const fingerprint = this._fingerprintRegistry.ensureFingerprint(newSession.sessionId, {
            trackId: null, startTime: Date.now(), streamIp: extractRequestIp(req)
          });
          return res.status(200).json({
            ok: true, stage: 'session',
            sessionId: newSession.sessionId, fingerprint,
            streamUrl: `${this._audioServerUrl}/stream?sessionId=${newSession.sessionId}`,
            eventsUrl: `${this._audioServerUrl}/events?sessionId=${newSession.sessionId}`
          });
        }
      }

      // Get state from Audio server
      let state;
      try {
        state = await this._audioClient.getFullState(session.sessionId);
      } catch (e) {
        return res.status(200).json({ ok: false, reason: 'audio_unavailable' });
      }

      if (stage === 'restart' || stage === 'rebroadcast') {
        if (stage === 'rebroadcast' && state.currentTrack) {
          await this._audioClient.broadcastHeartbeat(session.sessionId, 'manual-refresh', { force: true });
        }

        return res.status(200).json({
          ok: true,
          stage,
          sessionId: session.sessionId,
          fingerprint: this._fingerprintRegistry.getFingerprintForSession(session.sessionId),
          currentTrack: state.currentTrack,
          nextTrack: state.nextTrack,
          audioClients: state.audioClients,
          eventClients: state.eventClients,
          streamAlive: state.isActive || state.audioClients > 0
        });
      }

      res.status(200).json({ ok: false, reason: 'unknown_stage' });
    } catch (error) {
      console.error('🔄 SSE refresh error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ─── POST /refresh-sse-simple ───────────────────────────────────────────────

  async handleSimpleRefresh(req, res) {
    try {
      const { session } = await this._resolveSession(req, { createIfMissing: false });
      if (!session) return res.status(404).json({ error: 'Session not found' });

      let state;
      try {
        state = await this._audioClient.getFullState(session.sessionId);
      } catch (e) {
        return res.status(200).json({ ok: false, reason: 'audio_unavailable' });
      }

      const isStreaming = state.isActive || state.audioClients > 0;
      if (!isStreaming) {
        return res.status(200).json({ ok: false, reason: 'inactive', streamAlive: false });
      }

      if (state.currentTrack) {
        await this._audioClient.broadcastHeartbeat(session.sessionId, 'manual-refresh-simple', { force: true });
        return res.status(200).json({
          ok: true,
          currentTrack: state.currentTrack,
          nextTrack: state.nextTrack,
          audioClients: state.audioClients,
          eventClients: state.eventClients,
          streamAlive: true,
          sessionId: session.sessionId,
          fingerprint: this._fingerprintRegistry.getFingerprintForSession(session.sessionId)
        });
      }

      res.status(200).json({ ok: false, reason: 'no_track', streamAlive: true });
    } catch (error) {
      console.error('🔄 Simple SSE refresh error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = { SSEManager };
