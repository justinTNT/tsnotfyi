// SSE Manager — owns SSE connection lifecycle and refresh endpoints
// Phase 3: Extracted from server.js lines 878-1298

const serverLogger = require('../server-logger');
const sseLog = serverLogger.createLogger('sse');
const { buildRequestContext, extractRequestIp } = require('./session-manager');

class SSEManager {
  constructor({ sessionManager, fingerprintRegistry, persistAudioSessionBinding }) {
    this._sessionManager = sessionManager;
    this._fingerprintRegistry = fingerprintRegistry;
    this._persistAudioSessionBinding = persistAudioSessionBinding;
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

  // ─── GET /events ────────────────────────────────────────────────────────────

  async handleSSEConnection(req, res) {
    sseLog.info('📡 SSE connection attempt');

    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      const clientIp = extractRequestIp(req);
      const sm = this._sessionManager;

      const findOrphanSession = (ip) => {
        if (!ip) return null;

        for (const session of sm.allSessions()) {
          if (!session || !session.mixer) continue;

          const hasAudioClient = Boolean(session.mixer.clients && session.mixer.clients.size > 0);
          const hasEventClients = Boolean(session.mixer.eventClients && session.mixer.eventClients.size > 0);

          if (session.clientIp === ip && hasAudioClient && !hasEventClients) {
            return session;
          }
        }
        return null;
      };

      const persistBinding = (sessionId) => this._persistAudioSessionBinding(req, sessionId);
      const ctx = buildRequestContext(req, { persistBinding });

      let session = await sm.getSessionForContext(ctx, { createIfMissing: false });
      let resolution = session ? 'context' : null;

      if (!session) {
        session = findOrphanSession(clientIp);
        if (session) {
          resolution = 'orphan';
        }
      }

      if (!session && clientIp) {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          session = findOrphanSession(clientIp);
          if (session) {
            resolution = 'delayed_orphan';
            break;
          }
        }
      }

      if (!session && clientIp) {
        const fallbackSessionId = sm.lastHealthySessionByIp.get(clientIp);
        if (fallbackSessionId) {
          const fallbackSession = sm.getSessionById(fallbackSessionId);
          if (fallbackSession) {
            session = fallbackSession;
            resolution = 'last_healthy';
            sm.logSessionEvent('sse_rebound_last_healthy', {
              sessionId: session.sessionId,
              ip: clientIp
            });
          } else {
            sm.lastHealthySessionByIp.delete(clientIp);
          }
        }
      }

      let createdViaFallback = false;
      if (!session) {
        // Before creating a new session, check if any active session exists.
        // Multiple connections from different network interfaces on the same machine
        // should join the existing session, not spawn new ones with expensive ffmpeg decodes.
        for (const existing of sm.allSessions()) {
          if (existing?.mixer?.isActive || (existing?.mixer?.clients?.size > 0)) {
            session = existing;
            resolution = 'existing_active';
            sm.logSessionEvent('sse_joined_existing', {
              sessionId: existing.sessionId,
              ip: clientIp
            });
            break;
          }
        }
      }
      if (!session) {
        session = await sm.getSessionForContext(ctx, { createIfMissing: false });
        if (!session) {
          // No active session found — create one but don't start playback.
          // Playback begins when an audio client connects to /stream.
          session = await sm.createSession({ autoStart: false });
          sm.registerSession(session.sessionId, session);
        }
        resolution = resolution || 'fallback_create';
        createdViaFallback = true;
      }

      if (!session) {
        sm.logSessionEvent('sse_session_unavailable', {
          ip: clientIp,
          resolution
        }, { level: 'warn' });
        res.write('data: {"type":"error","message":"session_unavailable"}\n\n');
        return res.end();
      }

      await this._persistAudioSessionBinding(req, session.sessionId);

      session.lastMetadataConnect = Date.now();
      if (clientIp) {
        session.lastMetadataIp = clientIp;
      }

      if (createdViaFallback && session && session.mixer && session.mixer.clients && session.mixer.clients.size === 0) {
        session.awaitingAudioClient = true;
      }

      const currentTrackId = session.mixer?.state?.currentTrack?.identifier || null;
      const trackStartTime = session.mixer?.state?.trackStartTime || Date.now();
      const activeFingerprint = this._fingerprintRegistry.ensureFingerprint(
        session.sessionId,
        {
          trackId: currentTrackId,
          startTime: trackStartTime,
          metadataIp: clientIp
        }
      );

      if (clientIp && session.mixer?.clients && session.mixer.clients.size > 0) {
        sm.lastHealthySessionByIp.set(clientIp, session.sessionId);
      }

      console.log(JSON.stringify({
        _type: 'sse_connect',
        ts: new Date().toISOString(),
        sessionId: session.sessionId,
        trackId: session.mixer?.state?.currentTrack?.identifier?.substring(0, 8) || null,
        trackTitle: session.mixer?.state?.currentTrack?.title || null,
        resolution,
        ip: clientIp,
        audioClients: session.mixer?.clients?.size || 0
      }));

      sm.logSessionEvent('sse_client_connected', {
        sessionId: session.sessionId,
        fingerprint: activeFingerprint || null,
        ip: clientIp,
        resolution,
        audioClients: session.mixer?.clients?.size || 0,
        eventClients: session.mixer?.eventClients?.size || 0
      });

      const connectedPayload = {
        type: 'connected',
        sessionId: session.sessionId,
        fingerprint: activeFingerprint || null
      };
      res.write(`data: ${JSON.stringify(connectedPayload)}\n\n`);

      session.mixer.addEventClient(res);

      if (session.mixer.state.currentTrack &&
          session.mixer.isActive &&
          session.mixer.state.currentTrack.title &&
          session.mixer.state.currentTrack.title.trim() !== '') {
        sseLog.info('📡 Sending heartbeat to new SSE client (explorer via POST /explorer)');
        await session.mixer.broadcastHeartbeat('sse-connected', { force: true });
      } else {
        sseLog.info('📡 No valid current track yet; awaiting bootstrap before first heartbeat');
        try {
          const ready = await session.mixer.awaitCurrentTrackReady?.(15000);
          if (ready && session.mixer.state.currentTrack && session.mixer.isActive) {
            sseLog.info('📡 Bootstrap complete; dispatching initial heartbeat after wait');
            await session.mixer.broadcastHeartbeat('sse-connected', { force: true });
          } else {
            sseLog.warn('📡 Bootstrap wait timed out; current track still unavailable');
            res.write('data: {"type":"bootstrap_pending","message":"awaiting_current_track"}\n\n');
          }
        } catch (bootstrapError) {
          sseLog.error('📡 Bootstrap wait failed:', bootstrapError);
          res.write('data: {"type":"bootstrap_pending","message":"awaiting_current_track"}\n\n');
        }
      }

      req.on('close', () => {
        if (session && session.mixer.removeEventClient) {
          session.mixer.removeEventClient(res);
        }
      });

    } catch (error) {
      sseLog.error('📡 SSE connection error:', error);
      try {
        res.write('data: {"type":"error","message":"connection_failed"}\n\n');
        res.end();
      } catch (err) {
        // Ignore secondary failure
      }
    }
  }

  // ─── POST /refresh-sse ──────────────────────────────────────────────────────

  async handleRefresh(req, res) {
    const requestFingerprint = typeof req.body.fingerprint === 'string' ? req.body.fingerprint.trim() : null;
    const sessionIdFromBody = req.body.sessionId || req.session?.audioSessionId || null;
    const stageParam = typeof req.body.stage === 'string' ? req.body.stage.trim().toLowerCase() : null;
    const stage = ['session', 'restart', 'rebroadcast'].includes(stageParam) ? stageParam : 'rebroadcast';

    const sm = this._sessionManager;

    let session = null;
    if (requestFingerprint) {
      const entry = this._fingerprintRegistry.lookup(requestFingerprint);
      if (entry) {
        session = sm.getSessionById(entry.sessionId) || null;
        if (session) {
          this._fingerprintRegistry.touch(requestFingerprint, { metadataIp: req.ip });
        }
      }
    } else if (sessionIdFromBody) {
      session = sm.getSessionById(sessionIdFromBody);
    }

    if (!session && stage !== 'session') {
      return res.status(404).json({ error: 'Session not found' });
    }

    const resolvedSessionId = session?.sessionId || null;
    sm.logSessionEvent('refresh_request', {
      stage,
      sessionId: resolvedSessionId,
      fingerprintProvided: Boolean(requestFingerprint),
      sessionIdProvided: Boolean(sessionIdFromBody),
      ip: extractRequestIp(req)
    });

    try {
      if (stage === 'session') {
        const newSession = await sm.createSession({ autoStart: true });
        const currentTrack = newSession.mixer.state.currentTrack || null;
        const fingerprint = this._fingerprintRegistry.ensureFingerprint(newSession.sessionId, {
          trackId: currentTrack?.identifier || null,
          startTime: newSession.mixer.state.trackStartTime || Date.now(),
          streamIp: extractRequestIp(req)
        });

        sm.logSessionEvent('refresh_response', {
          stage: 'session',
          sessionId: newSession.sessionId,
          trackId: currentTrack?.identifier || null
        });

        return res.status(200).json({
          ok: true,
          stage: 'session',
          sessionId: newSession.sessionId,
          fingerprint,
          currentTrack,
          streamAlive: Boolean(currentTrack),
          streamUrl: '/stream',
          eventsUrl: '/events'
        });
      }

      const summary = session.mixer.getStreamSummary ? session.mixer.getStreamSummary() : null;
      const isStreaming = session.mixer.isStreamAlive ? session.mixer.isStreamAlive() :
        Boolean(session.mixer.audioMixer?.engine?.isStreaming || (session.mixer.clients && session.mixer.clients.size > 0));

      if (stage === 'restart') {
        await session.mixer.restartStream('manual-refresh');
        const restartSummary = session.mixer.getStreamSummary ? session.mixer.getStreamSummary() : summary;

        sm.logSessionEvent('refresh_response', {
          stage: 'restart',
          sessionId: session.sessionId,
          trackId: restartSummary?.currentTrack?.identifier || null
        });

        return res.status(200).json({
          ok: true,
          stage: 'restart',
          sessionId: session.sessionId,
          fingerprint: this._fingerprintRegistry.getFingerprintForSession(session.sessionId),
          currentTrack: restartSummary?.currentTrack || null,
          pendingTrack: restartSummary?.pendingTrack || null,
          nextTrack: restartSummary?.nextTrack || null,
          clientCount: restartSummary?.audioClientCount ?? (session.mixer.clients?.size || 0),
          eventClientCount: restartSummary?.eventClientCount ?? (session.mixer.eventClients?.size || 0),
          streamAlive: true
        });
      }

      if (!isStreaming) {
        sm.logSessionEvent('refresh_response', {
          stage: 'rebroadcast',
          sessionId: session.sessionId,
          streamAlive: false,
          note: 'inactive'
        }, { level: 'warn' });
        return res.status(200).json({ ok: false, reason: 'inactive', streamAlive: false });
      }

      if (session.mixer.state.currentTrack && session.mixer.state.currentTrack.path) {
        console.log(`🔄 Triggering heartbeat for session ${session.sessionId} (${session.mixer.eventClients.size} clients)`);
        await session.mixer.broadcastHeartbeat('manual-refresh', { force: true });

        const currentTrack = session.mixer.state.currentTrack || summary?.currentTrack || null;
        const pendingTrack = session.mixer.pendingCurrentTrack || summary?.pendingTrack || null;
        const nextTrack = session.mixer.nextTrack || summary?.nextTrack || null;
        const lastBroadcast = summary?.lastBroadcast || (session.mixer.lastTrackEventPayload ? {
          timestamp: session.mixer.lastTrackEventTimestamp,
          trackId: session.mixer.lastTrackEventPayload.currentTrack?.identifier || null
        } : null);

        sm.logSessionEvent('refresh_response', {
          stage: 'rebroadcast',
          sessionId: session.sessionId,
          trackId: currentTrack?.identifier || null
        });

        return res.status(200).json({
          ok: true,
          stage: 'rebroadcast',
          currentTrack,
          pendingTrack,
          nextTrack,
          clientCount: summary?.audioClientCount ?? (session.mixer.clients?.size || 0),
          eventClientCount: summary?.eventClientCount ?? (session.mixer.eventClients?.size || 0),
          lastBroadcast,
          streamAlive: true,
          sessionId: session.sessionId,
          fingerprint: this._fingerprintRegistry.getFingerprintForSession(session.sessionId)
        });
      }

      sm.logSessionEvent('refresh_response', {
        stage: 'rebroadcast',
        sessionId: session.sessionId,
        note: 'no_track'
      });
      res.status(200).json({ ok: false, reason: 'no_track', streamAlive: true });

    } catch (error) {
      console.error('🔄 SSE refresh error:', error);
      sm.logSessionEvent('refresh_response', {
        stage,
        sessionId: session?.sessionId || null,
        error: error?.message || String(error)
      }, { level: 'error' });
      res.status(500).json({ error: error.message });
    }
  }

  // ─── POST /refresh-sse-simple ───────────────────────────────────────────────

  async handleSimpleRefresh(req, res) {
    console.log('🔄 Simple SSE refresh request from client');

    try {
      const requestFingerprint = typeof req.body?.fingerprint === 'string'
        ? req.body.fingerprint.trim()
        : (typeof req.query?.fingerprint === 'string' ? req.query.fingerprint.trim() : null);

      const sm = this._sessionManager;

      let session = null;
      if (requestFingerprint) {
        const entry = this._fingerprintRegistry.lookup(requestFingerprint);
        if (entry) {
          session = sm.getSessionById(entry.sessionId) || null;
          if (session) {
            this._fingerprintRegistry.touch(requestFingerprint, { metadataIp: req.ip });
          }
        }
      }

      if (!session) {
        const persistBinding = (sessionId) => this._persistAudioSessionBinding(req, sessionId);
        const ctx = buildRequestContext(req, { persistBinding });
        session = await sm.getSessionForContext(ctx, { createIfMissing: false });
      }

      if (!session) {
        console.log('🔄 No session associated with request');
        return res.status(404).json({ error: 'Session not found' });
      }

      const summary = session.mixer.getStreamSummary ? session.mixer.getStreamSummary() : null;
      const isStreaming = session.mixer.isStreamAlive ? session.mixer.isStreamAlive() :
        Boolean(session.mixer.audioMixer?.engine?.isStreaming || (session.mixer.clients && session.mixer.clients.size > 0));

      if (!isStreaming) {
        console.log(`🔄 Session ${session.sessionId} reported inactive (no streaming clients)`);
        return res.status(200).json({ ok: false, reason: 'inactive', streamAlive: false });
      }

      if (session.mixer.state.currentTrack && session.mixer.state.currentTrack.path) {
        console.log(`🔄 Triggering heartbeat for session ${session.sessionId} (${session.mixer.eventClients.size} clients)`);
        await session.mixer.broadcastHeartbeat('manual-refresh-simple', { force: true });

        const currentTrack = session.mixer.state.currentTrack || summary?.currentTrack || null;
        const pendingTrack = session.mixer.pendingCurrentTrack || summary?.pendingTrack || null;
        const nextTrack = session.mixer.nextTrack || summary?.nextTrack || null;
        const lastBroadcast = summary?.lastBroadcast || (session.mixer.lastTrackEventPayload ? {
          timestamp: session.mixer.lastTrackEventTimestamp,
          trackId: session.mixer.lastTrackEventPayload.currentTrack?.identifier || null
        } : null);

        res.status(200).json({
          ok: true,
          currentTrack,
          pendingTrack,
          nextTrack,
          clientCount: summary?.audioClientCount ?? (session.mixer.clients?.size || 0),
          eventClientCount: summary?.eventClientCount ?? (session.mixer.eventClients?.size || 0),
          lastBroadcast,
          streamAlive: true,
          sessionId: session.sessionId,
          fingerprint: this._fingerprintRegistry.getFingerprintForSession(session.sessionId)
        });
      } else {
        console.log(`🔄 Session ${session.sessionId} has no valid track to broadcast`);
        res.status(200).json({ ok: false, reason: 'no_track', streamAlive: true });
      }

    } catch (error) {
      console.error('🔄 Simple SSE refresh error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = { SSEManager };
