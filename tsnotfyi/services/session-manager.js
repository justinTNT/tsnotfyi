// Session Manager — owns session lifecycle, maps, resolution, and priming
// Phase 2: Extracted from server.js lines 120-782

const crypto = require('crypto');
const DriftAudioMixer = require('../drift-audio-mixer');
const serverLogger = require('../server-logger');
const sessionLog = serverLogger.createLogger('session');

class SessionManager {
  constructor({ config, db, radialSearch, fingerprintRegistry, onExplorerNeeded }) {
    this._config = config;
    this._db = db;
    this._radialSearch = radialSearch;
    this._fingerprintRegistry = fingerprintRegistry;
    this._onExplorerNeeded = onExplorerNeeded || null; // async (mixer, trackId, opts) => explorerData|null

    // Session maps
    this._audioSessions = new Map();
    this._ephemeralSessions = new Map();
    this._lastHealthySessionByIp = new Map();

    // Priming
    this._primedSessionIds = new Set();
    this._primingSessionsInFlight = 0;
    this._desiredPrimedSessions = Math.max(
      0,
      Number.isFinite(Number(config.server?.primedSessionCount))
        ? Number(config.server.primedSessionCount)
        : 0
    );
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async close() {
    // Drain primed sessions
    this._primedSessionIds.clear();
    this._primingSessionsInFlight = 0;

    // Destroy all sessions
    for (const [sessionId, session] of this._audioSessions) {
      if (session.mixer && typeof session.mixer.destroy === 'function') {
        session.mixer.destroy();
      }
    }
    this._audioSessions.clear();

    for (const [sessionId, session] of this._ephemeralSessions) {
      if (session.mixer && typeof session.mixer.destroy === 'function') {
        session.mixer.destroy();
      }
    }
    this._ephemeralSessions.clear();
    this._lastHealthySessionByIp.clear();
  }

  // ─── Maps access ───────────────────────────────────────────────────────────

  get audioSessions() {
    return this._audioSessions;
  }

  get ephemeralSessions() {
    return this._ephemeralSessions;
  }

  get lastHealthySessionByIp() {
    return this._lastHealthySessionByIp;
  }

  get activeSessions() {
    return this._audioSessions.size;
  }

  allSessions() {
    return [...this._audioSessions.values(), ...this._ephemeralSessions.values()];
  }

  // ─── Lookup ─────────────────────────────────────────────────────────────────

  getSessionById(sessionId) {
    if (!sessionId) return null;
    return this._audioSessions.get(sessionId)
      || this._ephemeralSessions.get(sessionId)
      || null;
  }

  // ─── Registration ───────────────────────────────────────────────────────────

  registerSession(sessionId, session, { ephemeral = false } = {}) {
    if (ephemeral) {
      this._ephemeralSessions.set(sessionId, session);
    } else {
      this._audioSessions.set(sessionId, session);
    }
  }

  unregisterSession(sessionId) {
    if (this._ephemeralSessions.delete(sessionId)) {
      return;
    }
    this._audioSessions.delete(sessionId);
  }

  attachEphemeralCleanup(sessionId, session) {
    if (!session || !session.mixer) {
      return;
    }

    session.mixer.onIdle = () => {
      sessionLog.info(`🧹 Cleaning up ephemeral session: ${sessionId}`);
      this.unregisterSession(sessionId);
      session.mixer.onIdle = null;
    };
  }

  // ─── Session creation ───────────────────────────────────────────────────────

  async createSession(options = {}) {
    const {
      sessionId = `session_${crypto.randomBytes(4).toString('hex')}`,
      autoStart = true,
      register = true,
      ephemeral = false
    } = options;

    sessionLog.info(`🎯 Creating session: ${sessionId}`);

    const mixer = new DriftAudioMixer(sessionId, this._radialSearch);
    mixer.pendingClientBootstrap = true;

    // Delegate explorer computation to worker thread when available
    if (this._onExplorerNeeded) {
      const onExplorerNeeded = this._onExplorerNeeded;
      mixer.onExplorerNeeded = async (trackId, opts) => {
        return onExplorerNeeded(mixer, trackId, opts);
      };
    }

    // Record completion at halfway point
    mixer.onHalfwayReached = async (identifier) => {
      try {
        await this._db.recordCompletion(identifier);
        sessionLog.info(`🎵 Halfway reached for ${identifier.substring(0, 8)} — recorded completion`);
      } catch (err) {
        sessionLog.error(`Failed to record halfway completion for ${identifier}:`, err.message);
      }
    };

    if (autoStart) {
      try {
        await mixer.startDriftPlayback();
        sessionLog.info(`✅ Session ${sessionId} started with initial track`);
      } catch (error) {
        sessionLog.error(`❌ Failed to start session ${sessionId}:`, error);
      }
    }

    const session = {
      sessionId,
      mixer,
      created: new Date(),
      lastAccess: new Date(),
      isEphemeral: ephemeral
    };

    console.log(JSON.stringify({
      _type: 'session_created',
      ts: new Date().toISOString(),
      sessionId,
      trackId: mixer.state?.currentTrack?.identifier?.substring(0, 8) || null,
      trackTitle: mixer.state?.currentTrack?.title || null,
      autoStart,
      ephemeral,
      isPrimed: false
    }));

    if (register) {
      this.registerSession(sessionId, session, { ephemeral });
      if (ephemeral) {
        this.attachEphemeralCleanup(sessionId, session);
      }
    }

    return session;
  }

  // ─── Priming ────────────────────────────────────────────────────────────────

  async primeSession(reason = 'unspecified') {
    if (this._desiredPrimedSessions <= 0) {
      return;
    }

    this._primingSessionsInFlight += 1;
    try {
      const session = await this.createSession({ autoStart: true });
      if (session) {
        session.isPrimed = true;
        session.primeReason = reason;
        this._primedSessionIds.add(session.sessionId);
        console.log(JSON.stringify({
          _type: 'session_primed',
          ts: new Date().toISOString(),
          sessionId: session.sessionId,
          trackId: session.mixer?.state?.currentTrack?.identifier?.substring(0, 8) || null,
          trackTitle: session.mixer?.state?.currentTrack?.title || null,
          reason,
          primedCount: this._primedSessionIds.size
        }));
      }
    } catch (error) {
      sessionLog.error('🔥 Failed to prime drift session:', error);
    } finally {
      this._primingSessionsInFlight -= 1;
    }
  }

  schedulePrimedSessions(reason = 'unspecified') {
    if (this._desiredPrimedSessions <= 0) {
      return;
    }

    const needed = this._desiredPrimedSessions - this._primedSessionIds.size - this._primingSessionsInFlight;
    if (needed <= 0) {
      return;
    }

    for (let i = 0; i < needed; i += 1) {
      this.primeSession(reason).catch(err => {
        sessionLog.error('🔥 Primed session creation failed:', err);
      });
    }
  }

  checkoutPrimedSession(resolution = 'request') {
    if (!this._primedSessionIds.size) {
      return null;
    }

    const iterator = this._primedSessionIds.values().next();
    if (iterator.done) {
      return null;
    }

    const sessionId = iterator.value;
    this._primedSessionIds.delete(sessionId);

    const session = this.getSessionById(sessionId);
    if (!session) {
      sessionLog.warn(`🔥 Primed session ${sessionId} missing during checkout (${resolution})`);
      this.schedulePrimedSessions('stale-removal');
      return null;
    }

    session.isPrimed = false;
    console.log(JSON.stringify({
      _type: 'session_checkout',
      ts: new Date().toISOString(),
      sessionId,
      trackId: session.mixer?.state?.currentTrack?.identifier?.substring(0, 8) || null,
      trackTitle: session.mixer?.state?.currentTrack?.title || null,
      resolution,
      remainingPrimed: this._primedSessionIds.size
    }));
    setTimeout(() => this.schedulePrimedSessions('replenish'), 45000);
    return session;
  }

  // ─── Logging helpers ────────────────────────────────────────────────────────

  logSessionEvent(event, details = {}, { level = 'log' } = {}) {
    const payload = {
      event,
      ts: new Date().toISOString(),
      ...details
    };

    const message = `🛰️ session ${JSON.stringify(payload)}`;
    if (level === 'warn') {
      sessionLog.warn(message);
    } else if (level === 'error') {
      sessionLog.error(message);
    } else {
      sessionLog.info(message);
    }
  }

  logSessionResolution(ctx, source, outcome = {}) {
    this.logSessionEvent('resolution', {
      source,
      requested: outcome.requested || null,
      sessionId: outcome.sessionId || null,
      created: Boolean(outcome.created),
      cookieSession: ctx.cookieSessionId || null,
      ip: ctx.ip,
      note: outcome.note || null
    }, { level: outcome.level || 'log' });
  }

  // ─── Session resolution ─────────────────────────────────────────────────────

  /**
   * Resolve a session from a RequestContext.
   * ctx: { sessionId, fingerprint, ip, url, cookieSessionId, persistBinding }
   *   persistBinding: async (sessionId) => void — persists audio session binding to express session
   */
  async getSessionForContext(ctx, { createIfMissing = true } = {}) {
    const queryId = ctx.sessionId || null;
    const cookieId = ctx.cookieSessionId || null;
    const fingerprintParam = ctx.fingerprint || null;

    // Resolve session from fingerprint
    if (fingerprintParam && !queryId) {
      const entry = this._fingerprintRegistry.lookup(fingerprintParam);
      if (entry) {
        const session = this.getSessionById(entry.sessionId);
        if (session) {
          this.logSessionResolution(ctx, 'fingerprint', {
            requested: fingerprintParam.substring(0, 12),
            sessionId: session.sessionId,
            created: false
          });
          session.lastAccess = new Date();
          this._fingerprintRegistry.touch(fingerprintParam, { metadataIp: ctx.ip });
          return session;
        }
      }
    }

    // Resolve from explicit session ID (query param)
    if (queryId) {
      let session = this.getSessionById(queryId);
      let createdViaQuery = false;

      if (!session && createIfMissing) {
        session = await this.createSession({ sessionId: queryId });
        createdViaQuery = true;
      }

      if (session) {
        this.logSessionResolution(ctx, 'query', {
          requested: queryId,
          sessionId: session.sessionId,
          created: createdViaQuery,
          note: createdViaQuery ? 'created_missing_query_session' : null
        });
        session.lastAccess = new Date();
        if (ctx.persistBinding) await ctx.persistBinding(session.sessionId);
        return session;
      }

      this.logSessionResolution(ctx, 'query', {
        requested: queryId,
        sessionId: null,
        note: 'requested_not_found',
        level: 'warn'
      });
    }

    // Resolve from URL param
    if (ctx.paramSessionId) {
      const requestedId = ctx.paramSessionId;
      let session = this.getSessionById(requestedId);
      const createdFromParam = !session && createIfMissing;

      if (!session && createIfMissing) {
        session = await this.createSession({ sessionId: requestedId });
      }

      if (session) {
        this.logSessionResolution(ctx, 'param', {
          requested: requestedId,
          sessionId: session.sessionId,
          created: createdFromParam
        });
        session.lastAccess = new Date();
        if (ctx.persistBinding) await ctx.persistBinding(session.sessionId);
      }

      if (!session) {
        this.logSessionResolution(ctx, 'param', {
          requested: requestedId,
          sessionId: null,
          note: 'requested_not_found',
          level: createIfMissing ? 'warn' : 'log'
        });
      }

      return session;
    }

    // Resolve from cookie (express session)
    if (cookieId !== undefined) {
      let session = cookieId ? this.getSessionById(cookieId) : null;

      if (!session && createIfMissing) {
        session = this.checkoutPrimedSession('cookie');
        if (!session) {
          session = await this.createSession();
          this.schedulePrimedSessions('cookie-backfill');
        }
      }

      if (session) {
        session.lastAccess = new Date();
        this.logSessionResolution(ctx, 'cookie', {
          requested: cookieId || null,
          sessionId: session.sessionId,
          created: !cookieId,
          note: session.sessionId !== cookieId ? 'cookie_rebound' : null
        });
        if (ctx.persistBinding) await ctx.persistBinding(session.sessionId);
      }

      if (!session) {
        this.logSessionResolution(ctx, 'cookie', {
          requested: cookieId || null,
          sessionId: null,
          note: 'cookie_session_missing',
          level: createIfMissing ? 'warn' : 'log'
        });
      }

      return session;
    }

    if (!createIfMissing) {
      this.logSessionResolution(ctx, 'fallback', {
        sessionId: null,
        note: 'create_disabled'
      });
      return null;
    }

    // Before creating, check if an active session already exists.
    // Prevents duplicate sessions from different network interfaces on the same machine.
    // Prefer ephemeral sessions over named ones (ephemeral = current drift, named = saved journey).
    let bestExisting = null;
    for (const existing of this._audioSessions.values()) {
      if (existing?.mixer?.isActive || (existing?.mixer?.clients?.size > 0)) {
        if (!bestExisting || existing.isEphemeral) {
          bestExisting = existing;
        }
      }
    }
    if (!bestExisting) {
      for (const existing of this._ephemeralSessions.values()) {
        if (existing?.mixer?.isActive || (existing?.mixer?.clients?.size > 0)) {
          bestExisting = existing;
          break;
        }
      }
    }
    if (bestExisting) {
      this.logSessionResolution(ctx, 'existing_active', {
        sessionId: bestExisting.sessionId,
        created: false,
        note: bestExisting.isEphemeral ? 'joined_existing_ephemeral' : 'joined_existing_named'
      });
      bestExisting.lastAccess = new Date();
      if (ctx.persistBinding) await ctx.persistBinding(bestExisting.sessionId);
      return bestExisting;
    }

    let session = this.checkoutPrimedSession('fallback');
    if (!session) {
      session = await this.createSession();
      this.schedulePrimedSessions('fallback-backfill');
    }
    session.lastAccess = new Date();
    if (ctx.persistBinding) await ctx.persistBinding(session.sessionId);
    this.logSessionResolution(ctx, 'fallback', {
      sessionId: session.sessionId,
      created: true,
      note: 'created_new_session'
    });
    return session;
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────

  cleanupInactiveSessions(timeoutMs = 60 * 60 * 1000) {
    const now = new Date();

    for (const [sessionId, session] of this._audioSessions) {
      const hasActiveAudioClients = session.mixer.clients && session.mixer.clients.size > 0;
      const hasActiveEventClients = session.mixer.eventClients && session.mixer.eventClients.size > 0;
      const isActiveStreaming = session.mixer.isActive;
      const hasRecentActivity = (now - session.lastAccess) < timeoutMs;

      if (hasActiveAudioClients || hasActiveEventClients || isActiveStreaming || hasRecentActivity) {
        continue;
      }

      console.log(`🧹 Cleaning up inactive session: ${sessionId} (idle: ${Math.round((now - session.lastAccess) / 60000)}m)`);
      session.mixer.destroy();
      this._audioSessions.delete(sessionId);
    }
  }
}

// ─── RequestContext builder ─────────────────────────────────────────────────

function extractRequestIp(req) {
  return req?.ip || req?.socket?.remoteAddress || null;
}

function buildRequestContext(req, { persistBinding } = {}) {
  return {
    sessionId: req.query && typeof req.query.session === 'string' ? req.query.session.trim() || null : null,
    fingerprint: req.query && typeof req.query.fingerprint === 'string' ? req.query.fingerprint.trim() || null : null,
    paramSessionId: req.params?.sessionId || null,
    ip: extractRequestIp(req),
    userAgent: req.headers?.['user-agent'] || null,
    url: req.originalUrl || req.url || null,
    cookieSessionId: req.session?.audioSessionId,
    persistBinding
  };
}

module.exports = { SessionManager, buildRequestContext, extractRequestIp };
