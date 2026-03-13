require('./utils/logTimestamps');
const express = require('express');
const session = require('express-session');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const DriftAudioMixer = require('./drift-audio-mixer');
const RadialSearchService = require('./radial-search');
const VAEService = require('./services/vaeService');
const { Pool } = require('pg');
const fingerprintRegistry = require('./fingerprint-registry');
const serverLogger = require('./server-logger');
const internalMetrics = require('./metrics/internalMetrics');
const { ExplorerResponse, validateOrWarn } = require('./contracts-zod');
const { setupPlaylistRoutes } = require('./routes/playlist');
const { setupNamedSessionRoutes, isValidMD5, RESERVED_SESSION_PREFIXES } = require('./routes/named-session');
const { setupApiRoutes } = require('./routes/api');
const { setupVaeRoutes } = require('./routes/vae');

const startupLog = serverLogger.createLogger('startup');
const serverLog = serverLogger.createLogger('server');
const sessionLog = serverLogger.createLogger('session');
const dbLog = serverLogger.createLogger('database');
const timingLog = serverLogger.createLogger('timing');
const sseLog = serverLogger.createLogger('sse');
const searchLog = serverLogger.createLogger('search');

// Load configuration
const configPath = path.join(__dirname, 'tsnotfyi-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (config.logging?.channels) {
  serverLogger.configureFromSpec(config.logging.channels);
}

const app = express();
const port = config.server.port;
const pidFile = path.join(__dirname, config.server.pidFile);


async function persistAudioSessionBinding(req, sessionId) {
  if (!req || !req.session) {
    return;
  }

  if (req.session.audioSessionId === sessionId) {
    return;
  }

  req.session.audioSessionId = sessionId;

  if (typeof req.session.save !== 'function') {
    return;
  }

  await new Promise((resolve) => {
    req.session.save((err) => {
      if (err) {
        sessionLog.error('⚠️ Failed to persist express session binding', err);
      }
      resolve();
    });
  });
}


// Singleton protection - prevent multiple server instances
function checkSingleton() {
  if (fs.existsSync(pidFile)) {
    try {
      const existingPid = fs.readFileSync(pidFile, 'utf8').trim();
      // Check if process is actually running
      try {
        process.kill(existingPid, 0); // Signal 0 just checks if process exists
        startupLog.error(`❌ SINGLETON VIOLATION: Server already running with PID ${existingPid}`);
        startupLog.error(`❌ Kill the existing server first: kill ${existingPid}`);
        process.exit(1);
      } catch (err) {
        // Process doesn't exist, remove stale PID file
        startupLog.info(`🧹 Removing stale PID file for non-existent process ${existingPid}`);
        fs.unlinkSync(pidFile);
      }
    } catch (err) {
      startupLog.info(`🧹 Removing corrupted PID file`);
      fs.unlinkSync(pidFile);
    }
  }

  // Write our PID
  startupLog.info(`🔒 1 Server singleton locking with PID ${process.pid}`);
  startupLog.info(`🔒 2 Server singleton locking with PID ${process.pid}`);
  startupLog.info(`🔒 3 Server singleton locking with PID ${process.pid}`);
  startupLog.info(`🔒 4 Server singleton locking with PID ${process.pid}`);

  try {
    fs.writeFileSync(pidFile, process.pid.toString());
  } catch (err) {
    startupLog.error('Failed writing PID file', err);
    process.exit(2);
  }
  startupLog.info(`🔒 Server singleton locked with PID ${process.pid}`);

  // Clean up PID file on exit
  process.on('exit', () => {
    try {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
        startupLog.info(`🔓 Released singleton lock`);
      }
    } catch (err) {
      startupLog.error('Error removing PID file:', err);
    }
  });
}

// Server startup handled in startServer() to support test harness

const audioSessions = new Map(); // Keep for backward compatibility
const ephemeralSessions = new Map(); // One-off MD5 journey sessions
const lastHealthySessionByIp = new Map();

const primedSessionIds = new Set();
let primingSessionsInFlight = 0;
const desiredPrimedSessions = Math.max(
  0,
  Number.isFinite(Number(config.server?.primedSessionCount))
    ? Number(config.server.primedSessionCount)
    : 0
);

function extractRequestIp(req) {
  return req?.ip || req?.socket?.remoteAddress || null;
}

function logSessionEvent(event, details = {}, { level = 'log' } = {}) {
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

function logSessionResolution(req, source, outcome = {}) {
  logSessionEvent('resolution', {
    source,
    requested: outcome.requested || null,
    sessionId: outcome.sessionId || null,
    created: Boolean(outcome.created),
    cookieSession: req?.session?.audioSessionId || null,
    ip: extractRequestIp(req),
    note: outcome.note || null
  }, { level: outcome.level || 'log' });
}

function registerSession(sessionId, session, { ephemeral = false } = {}) {
  if (ephemeral) {
    ephemeralSessions.set(sessionId, session);
  } else {
    audioSessions.set(sessionId, session);
  }
}

function unregisterSession(sessionId) {
  if (ephemeralSessions.delete(sessionId)) {
    return;
  }
  audioSessions.delete(sessionId);
}

function getSessionById(sessionId) {
  if (!sessionId) return null;
  return audioSessions.get(sessionId) || ephemeralSessions.get(sessionId) || null;
}

async function primeSession(reason = 'unspecified') {
  if (desiredPrimedSessions <= 0) {
    return;
  }

  primingSessionsInFlight += 1;
  try {
    const session = await createSession({ autoStart: true });
    if (session) {
      session.isPrimed = true;
      session.primeReason = reason;
      primedSessionIds.add(session.sessionId);
      sessionLog.info(`🔥 Primed drift session ready: ${session.sessionId} (${reason})`);
    }
  } catch (error) {
    sessionLog.error('🔥 Failed to prime drift session:', error);
  } finally {
    primingSessionsInFlight -= 1;
  }
}

function schedulePrimedSessions(reason = 'unspecified') {
  if (desiredPrimedSessions <= 0) {
    return;
  }

  const needed = desiredPrimedSessions - primedSessionIds.size - primingSessionsInFlight;
  if (needed <= 0) {
    return;
  }

  for (let i = 0; i < needed; i += 1) {
    primeSession(reason).catch(err => {
      sessionLog.error('🔥 Primed session creation failed:', err);
    });
  }
}

function checkoutPrimedSession(resolution = 'request') {
  if (!primedSessionIds.size) {
    return null;
  }

  const iterator = primedSessionIds.values().next();
  if (iterator.done) {
    return null;
  }

  const sessionId = iterator.value;
  primedSessionIds.delete(sessionId);

  const session = getSessionById(sessionId);
  if (!session) {
    sessionLog.warn(`🔥 Primed session ${sessionId} missing during checkout (${resolution})`);
    schedulePrimedSessions('stale-removal');
    return null;
  }

  session.isPrimed = false;
  sessionLog.info(`🔥 Primed session ${sessionId} assigned (${resolution})`);
  setTimeout(() => schedulePrimedSessions('replenish'), 45000);
  return session;
}

function attachEphemeralCleanup(sessionId, session) {
  if (!session || !session.mixer) {
    return;
  }

  session.mixer.onIdle = () => {
    sessionLog.info(`🧹 Cleaning up ephemeral session: ${sessionId}`);
    unregisterSession(sessionId);
    session.mixer.onIdle = null;
  };
}

// Initialize radial search service
const radialSearch = new RadialSearchService();

// Initialize VAE service
const vaeService = new VAEService({
  modelPath: config.vae?.modelPath || path.join(__dirname, 'models/music_vae.pt'),
  pythonPath: config.vae?.pythonPath || 'python3',
  scriptPath: path.join(__dirname, 'scripts/vae_inference.py')
});

// Initialize database connection
const TRIGRAM_SIMILARITY_THRESHOLD = parseFloat(process.env.SEARCH_SIMILARITY_THRESHOLD || '0.18');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || config.database.postgresql.connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  dbLog.info('📊 Connected to PostgreSQL music database');
});

pool.on('error', (err) => {
  dbLog.error('Unexpected database error:', err);
});

pool.on('connect', (client) => {
  client.query('SELECT set_limit($1)', [TRIGRAM_SIMILARITY_THRESHOLD]).catch(err => {
    dbLog.warn('⚠️ Failed to set pg_trgm similarity threshold:', err?.message || err);
  });
});

async function initializeServices() {
  if (process.env.SKIP_SERVICE_INIT) {
    startupLog.info('Skipping service initialization (SKIP_SERVICE_INIT set)');
    return;
  }
  try {
    await radialSearch.initialize();
    searchLog.info('✅ Radial search service initialized');
    
    // Initialize VAE service (optional - may not have model available)
    try {
      await vaeService.initialize();
      serverLog.info('✅ VAE service initialized');
    } catch (vaeError) {
      serverLog.warn('⚠️ VAE service initialization failed (continuing without VAE):', vaeError.message);
    }
  } catch (err) {
    startupLog.error('Failed to initialize services:', err);
  }
}

async function createSession(options = {}) {
  const {
    sessionId = `session_${crypto.randomBytes(4).toString('hex')}`,
    autoStart = true,
    register = true,
    ephemeral = false
  } = options;

  sessionLog.info(`🎯 Creating session: ${sessionId}`);

  const mixer = new DriftAudioMixer(sessionId, radialSearch);
  mixer.pendingClientBootstrap = true;

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

  if (register) {
    registerSession(sessionId, session, { ephemeral });
    if (ephemeral) {
      attachEphemeralCleanup(sessionId, session);
    }
  }

  return session;
}

function findTrackInExplorerSnapshot(explorer, trackId) {
  if (!explorer || !trackId) return null;

  const inspectSamples = (directionKey, direction) => {
    if (!direction) return null;
    const samples = Array.isArray(direction.sampleTracks) ? direction.sampleTracks : [];
    for (const sample of samples) {
      const track = sample && typeof sample === 'object' && sample.track ? sample.track : sample;
      if (track && track.identifier === trackId) {
        return { directionKey, track };
      }
    }
    return null;
  };

  const directions = explorer.directions || {};
  for (const [key, direction] of Object.entries(directions)) {
    const match = inspectSamples(key, direction);
    if (match) return match;

    if (direction?.oppositeDirection) {
      const oppositeKey = direction.oppositeDirection.key || direction.oppositeDirection.direction || null;
      const oppositeMatch = inspectSamples(oppositeKey || key, direction.oppositeDirection);
      if (oppositeMatch) return oppositeMatch;
    }
  }

  const nextTrack = explorer.nextTrack?.track || explorer.nextTrack;
  if (nextTrack?.identifier === trackId) {
    const directionKey = explorer.nextTrack?.directionKey || explorer.nextTrack?.direction || null;
    return { directionKey, track: nextTrack };
  }

  return null;
}

const servicesReady = initializeServices();
servicesReady.then(() => {
  schedulePrimedSessions('startup');
}).catch(err => {
  serverLog.error('🔥 Failed to schedule startup primed sessions:', err);
});

// Prune stale fingerprints every minute (5 minute TTL)
setInterval(() => {
  try {
    fingerprintRegistry.pruneStale(60 * 60 * 1000); // prune entries older than 1 hour
  } catch (err) {
    serverLog.warn('⚠️ Fingerprint prune failed:', err?.message || err);
  }
}, 10 * 60 * 1000);

// Serve static files and middleware
const defaultJsonParser = express.json({ limit: '8mb' });
const clientLogJsonParser = express.json({ limit: '32mb' });

app.post('/client-logs', clientLogJsonParser, (req, res) => {
  const { sessionId = null, entries = [], reason = 'unspecified', clientTimestamp = Date.now() } = req.body || {};
  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(204).end();
    return;
  }

  try {
    serverLogger.writeClientLogBatch(sessionId, entries, { reason, clientTimestamp });
    res.json({ ok: true, accepted: entries.length });
  } catch (error) {
    console.error('❌ Failed to persist client log batch', {
      sessionId: sessionId || null,
      reason,
      entries: entries.length,
      error: error?.message || error
    });
    res.status(500).json({ ok: false, error: 'client-log-write-failed' });
  }
});

app.use(defaultJsonParser);

// Session middleware (infrastructure only - not changing behavior yet)
app.use(session({
  secret: process.env.SESSION_SECRET || config.session.secret,
  resave: false,
  saveUninitialized: true, // Create session for every visitor
  cookie: {
    maxAge: config.session.maxAge,
    httpOnly: true,
    secure: config.session.cookieSecure
  },
  name: config.session.cookieName
}));

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    const routePath = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : req.path || (req.originalUrl ? req.originalUrl.split('?')[0] : 'unknown');
    internalMetrics.recordHttpRequest({
      method: req.method,
      path: routePath,
      statusCode: res.statusCode,
      durationMs: elapsed
    });
  });
  next();
});

app.use(express.static('public'));
app.use( '/images', express.static('images') );
app.use( '/Volumes', express.static('/Volumes', { fallthrough: false }) );

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    console.error('🚫 Request payload exceeded limit', {
      path: req.path,
      limit: err.limit,
      length: err.length
    });
    res.status(413).json({ ok: false, error: 'payload-too-large' });
    return;
  }
  next(err);
});

// Create a new session on demand
app.post('/create-session', async (req, res) => {
  try {
    const session = await createSession();
    res.json({
      sessionId: session.sessionId,
      streamUrl: '/stream',
      webUrl: '/'
    });
  } catch (error) {
    sessionLog.error('Failed to create session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.post('/session/bootstrap', async (req, res) => {
  try {
    const session = await getSessionForRequest(req, { createIfMissing: true });

    if (!session) {
      logSessionEvent('session_bootstrap_failed', {
        reason: 'session_unavailable',
        ip: extractRequestIp(req)
      }, { level: 'warn' });
      return res.status(503).json({ error: 'Session unavailable' });
    }

    const fingerprint = fingerprintRegistry.getFingerprintForSession(session.sessionId);
    logSessionEvent('session_bootstrap', {
      sessionId: session.sessionId,
      fingerprint: fingerprint || null,
      ip: extractRequestIp(req)
    });

    res.json({
      sessionId: session.sessionId,
      fingerprint: fingerprint || null,
      mixerReady: Boolean(session.mixer && !session.mixer.pendingClientBootstrap),
      createdAt: session.created ? session.created.toISOString() : null
    });
  } catch (error) {
    sessionLog.error('Failed to bootstrap session:', error);
    res.status(500).json({ error: 'Failed to bootstrap session' });
  }
});

// Bootstrap a stream and return fingerprint and stream URL
async function getSessionForRequest(req, { createIfMissing = true } = {}) {
  const queryIdRaw = req.query && typeof req.query.session === 'string' ? req.query.session.trim() : null;
  const queryId = queryIdRaw || null;
  const cookieId = req.session?.audioSessionId || null;

  // Resolve session from fingerprint query param (used by /current-track sentinel fetch)
  const fingerprintParam = req.query && typeof req.query.fingerprint === 'string' ? req.query.fingerprint.trim() : null;
  if (fingerprintParam && !queryId) {
    const entry = fingerprintRegistry.lookup(fingerprintParam);
    if (entry) {
      const session = getSessionById(entry.sessionId);
      if (session) {
        logSessionResolution(req, 'fingerprint', {
          requested: fingerprintParam.substring(0, 12),
          sessionId: session.sessionId,
          created: false
        });
        session.lastAccess = new Date();
        fingerprintRegistry.touch(fingerprintParam, { metadataIp: req.ip });
        return session;
      }
    }
  }

  if (queryId) {
    let session = getSessionById(queryId);
    let createdViaQuery = false;

    if (!session && createIfMissing) {
      session = await createSession({ sessionId: queryId });
      createdViaQuery = true;
    }

    if (session) {
      logSessionResolution(req, 'query', {
        requested: queryId,
        sessionId: session.sessionId,
        created: createdViaQuery,
        note: createdViaQuery ? 'created_missing_query_session' : null
      });
      session.lastAccess = new Date();
      await persistAudioSessionBinding(req, session.sessionId);
      return session;
    }

    logSessionResolution(req, 'query', {
      requested: queryId,
      sessionId: null,
      note: 'requested_not_found',
      level: 'warn'
    });
  }

  if (req.params && req.params.sessionId) {
    const requestedId = req.params.sessionId;
    let session = getSessionById(requestedId);
    const createdFromParam = !session && createIfMissing;

    if (!session && createIfMissing) {
      session = await createSession({ sessionId: requestedId });
    }

    if (session) {
      logSessionResolution(req, 'param', {
        requested: requestedId,
        sessionId: session.sessionId,
        created: createdFromParam
      });
      session.lastAccess = new Date();
      await persistAudioSessionBinding(req, session.sessionId);
    }

    if (!session) {
      logSessionResolution(req, 'param', {
        requested: requestedId,
        sessionId: null,
        note: 'requested_not_found',
        level: createIfMissing ? 'warn' : 'log'
      });
    }

    return session;
  }

  const expressSession = req.session;
  if (expressSession) {
    const existingId = expressSession.audioSessionId;
    let session = existingId ? getSessionById(existingId) : null;

    if (!session && createIfMissing) {
      session = checkoutPrimedSession('cookie');
      if (!session) {
        session = await createSession();
        schedulePrimedSessions('cookie-backfill');
      }
    }

    if (session) {
      session.lastAccess = new Date();
      logSessionResolution(req, 'cookie', {
        requested: existingId || null,
        sessionId: session.sessionId,
        created: !existingId,
        note: session.sessionId !== existingId ? 'cookie_rebound' : null
      });
      await persistAudioSessionBinding(req, session.sessionId);
    }

    if (!session) {
      logSessionResolution(req, 'cookie', {
        requested: existingId || null,
        sessionId: null,
        note: 'cookie_session_missing',
        level: createIfMissing ? 'warn' : 'log'
      });
    }

    return session;
  }

  if (!createIfMissing) {
    logSessionResolution(req, 'fallback', {
      sessionId: null,
      note: 'create_disabled'
    });
    return null;
  }

  let session = checkoutPrimedSession('fallback');
  if (!session) {
    session = await createSession();
    schedulePrimedSessions('fallback-backfill');
  }
  session.lastAccess = new Date();
  await persistAudioSessionBinding(req, session.sessionId);
  logSessionResolution(req, 'fallback', {
    sessionId: session.sessionId,
    created: true,
    note: 'created_new_session'
  });
  return session;
}

// Simplified stream endpoint - resolves session from request context
app.get('/stream', async (req, res) => {
  try {
    const session = await getSessionForRequest(req, { createIfMissing: true });

    if (!session) {
      logSessionEvent('audio_stream_request_failed', {
        reason: 'session_unavailable',
        ip: extractRequestIp(req)
      }, { level: 'warn' });
      return res.status(404).json({ error: 'Session not found' });
    }

    const clientIp = extractRequestIp(req);
    session.clientIp = clientIp;
    session.lastAudioConnect = Date.now();

    const currentTrackId = session.mixer?.currentTrack?.identifier || null;
    const trackStartTime = session.mixer?.trackStartTime || Date.now();
    const fingerprint = fingerprintRegistry.ensureFingerprint(
      session.sessionId,
      {
        trackId: currentTrackId,
        startTime: trackStartTime,
        streamIp: clientIp
      }
    );

    logSessionEvent('audio_stream_request', {
      sessionId: session.sessionId,
      fingerprint: fingerprint || null,
      ip: clientIp,
      method: req.method
    });

    if (req.method === 'HEAD') {
      return res.end();
    }

    session.mixer.addClient(res);

    session.awaitingAudioClient = false;
    session.lastAudioClientAt = Date.now();

    if (clientIp) {
      lastHealthySessionByIp.set(clientIp, session.sessionId);
    }

    logSessionEvent('audio_client_connected', {
      sessionId: session.sessionId,
      fingerprint: fingerprint || null,
      ip: clientIp,
      clientCount: session.mixer?.clients?.size || 0
    });
  } catch (error) {
    console.error('Stream connection error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to attach to stream' });
    } else {
      res.end();
    }
  }
});

// Stream endpoint - this is where browsers connect for audio (backward compatibility)
app.get('/stream/:sessionId', (req, res) => {
  serverLog.warn(`⚠️ Deprecated stream URL requested: /stream/${req.params.sessionId}`);
  res.status(410).json({ error: 'Session-specific stream URLs have been removed. Connect to /stream instead.' });
});

// NOTE: Named session creation endpoints removed - see SESSIONS_ROADMAP.md for reintroduction plan

// Legacy session route – create/attach then redirect to root
app.get('/session/:sessionId', async (req, res) => {
  const requestedId = req.params.sessionId;
  const isFollowMode = req.query.mode === 'follow';

  try {
    const session = await getSessionForRequest(req, { createIfMissing: true });

    if (session) {
      await persistAudioSessionBinding(req, session.sessionId);
    }

    serverLog.info(`${isFollowMode ? '👁️' : '🎮'} Legacy session request for ${requestedId}; redirecting to '/'`);
  } catch (error) {
    serverLog.error('Failed to resolve session for legacy /session/:sessionId route:', error);
  }

  res.redirect(302, isFollowMode ? '/?mode=follow' : '/');
});


// Simplified events endpoint - resolves session from request context
app.get('/events', async (req, res) => {
  sseLog.info('📡 SSE connection attempt');

  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const clientIp = req.ip || req.socket?.remoteAddress || null;

    const findOrphanSession = (ip) => {
      if (!ip) {
        return null;
      }

      for (const session of audioSessions.values()) {
        if (!session || !session.mixer) {
          continue;
        }

        const hasAudioClient = Boolean(session.mixer.clients && session.mixer.clients.size > 0);
        const hasEventClients = Boolean(session.mixer.eventClients && session.mixer.eventClients.size > 0);

        if (session.clientIp === ip && hasAudioClient && !hasEventClients) {
          return session;
        }
      }

      for (const session of ephemeralSessions.values()) {
        if (!session || !session.mixer) {
          continue;
        }

        const hasAudioClient = Boolean(session.mixer.clients && session.mixer.clients.size > 0);
        const hasEventClients = Boolean(session.mixer.eventClients && session.mixer.eventClients.size > 0);

        if (session.clientIp === ip && hasAudioClient && !hasEventClients) {
          return session;
        }
      }

      return null;
    };

    let session = await getSessionForRequest(req, { createIfMissing: false });
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
      const fallbackSessionId = lastHealthySessionByIp.get(clientIp);
      if (fallbackSessionId) {
        const fallbackSession = getSessionById(fallbackSessionId);
        if (fallbackSession) {
          session = fallbackSession;
          resolution = 'last_healthy';
          logSessionEvent('sse_rebound_last_healthy', {
            sessionId: session.sessionId,
            ip: clientIp
          });
        } else {
          lastHealthySessionByIp.delete(clientIp);
        }
      }
    }

    let createdViaFallback = false;
    if (!session) {
      session = await getSessionForRequest(req, { createIfMissing: true });
      resolution = resolution || 'fallback_create';
      createdViaFallback = true;
    }

    if (!session) {
      logSessionEvent('sse_session_unavailable', {
        ip: clientIp,
        resolution
      }, { level: 'warn' });
      res.write('data: {"type":"error","message":"session_unavailable"}\n\n');
      return res.end();
    }

    await persistAudioSessionBinding(req, session.sessionId);

    session.lastMetadataConnect = Date.now();
    if (clientIp) {
      session.lastMetadataIp = clientIp;
    }

    if (createdViaFallback && session && session.mixer && session.mixer.clients && session.mixer.clients.size === 0) {
      session.awaitingAudioClient = true;
    }

    const currentTrackId = session.mixer?.currentTrack?.identifier || null;
    const trackStartTime = session.mixer?.trackStartTime || Date.now();
    const activeFingerprint = fingerprintRegistry.ensureFingerprint(
      session.sessionId,
      {
        trackId: currentTrackId,
        startTime: trackStartTime,
        metadataIp: clientIp
      }
    );

    if (clientIp && session.mixer?.clients && session.mixer.clients.size > 0) {
      lastHealthySessionByIp.set(clientIp, session.sessionId);
    }

    logSessionEvent('sse_client_connected', {
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

    if (session.mixer.currentTrack &&
        session.mixer.isActive &&
        session.mixer.currentTrack.title &&
        session.mixer.currentTrack.title.trim() !== '') {
      sseLog.info('📡 Sending heartbeat to new SSE client (explorer via POST /explorer)');
      await session.mixer.broadcastHeartbeat('sse-connected', { force: true });
      // Explorer snapshots now fetched via POST /explorer - no longer broadcast via SSE
    } else {
      sseLog.info('📡 No valid current track yet; awaiting bootstrap before first heartbeat');
      try {
        const ready = await session.mixer.awaitCurrentTrackReady?.(15000);
        if (ready && session.mixer.currentTrack && session.mixer.isActive) {
          sseLog.info('📡 Bootstrap complete; dispatching initial heartbeat after wait');
          await session.mixer.broadcastHeartbeat('sse-connected', { force: true });
          // Explorer snapshots now fetched via POST /explorer - no longer broadcast via SSE
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
});

// Server-Sent Events endpoint for real-time updates (backward compatibility)
app.get('/events/:sessionId', (req, res) => {
  sseLog.warn(`⚠️ Deprecated SSE URL requested: /events/${req.params.sessionId}`);
  res.status(410).json({ error: 'Session-specific SSE URLs have been removed. Connect to /events instead.' });
});

// SSE refresh endpoint - triggers server to rebroadcast current state via SSE (pull/monadic)
app.post('/refresh-sse', async (req, res) => {
  const requestFingerprint = typeof req.body.fingerprint === 'string' ? req.body.fingerprint.trim() : null;
  const sessionIdFromBody = req.body.sessionId || req.session?.audioSessionId || null;
  const stageParam = typeof req.body.stage === 'string' ? req.body.stage.trim().toLowerCase() : null;
  const stage = ['session', 'restart', 'rebroadcast'].includes(stageParam) ? stageParam : 'rebroadcast';

  let session = null;
  if (requestFingerprint) {
    const entry = fingerprintRegistry.lookup(requestFingerprint);
    if (entry) {
      session = getSessionById(entry.sessionId) || null;
      if (session) {
        fingerprintRegistry.touch(requestFingerprint, { metadataIp: req.ip });
      }
    }
  } else if (sessionIdFromBody) {
    session = getSessionById(sessionIdFromBody);
  }

  if (!session && stage !== 'session') {
    return res.status(404).json({ error: 'Session not found' });
  }

  const resolvedSessionId = session?.sessionId || null;
  logSessionEvent('refresh_request', {
    stage,
    sessionId: resolvedSessionId,
    fingerprintProvided: Boolean(requestFingerprint),
    sessionIdProvided: Boolean(sessionIdFromBody),
    ip: extractRequestIp(req)
  });

  try {
    if (stage === 'session') {
      const newSession = await createSession({ autoStart: true });
      const currentTrack = newSession.mixer.currentTrack || null;
      const fingerprint = fingerprintRegistry.ensureFingerprint(newSession.sessionId, {
        trackId: currentTrack?.identifier || null,
        startTime: newSession.mixer.trackStartTime || Date.now(),
        streamIp: extractRequestIp(req)
      });

      logSessionEvent('refresh_response', {
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

      logSessionEvent('refresh_response', {
        stage: 'restart',
        sessionId: session.sessionId,
        trackId: restartSummary?.currentTrack?.identifier || null
      });

      return res.status(200).json({
        ok: true,
        stage: 'restart',
        sessionId: session.sessionId,
        fingerprint: fingerprintRegistry.getFingerprintForSession(session.sessionId),
        currentTrack: restartSummary?.currentTrack || null,
        pendingTrack: restartSummary?.pendingTrack || null,
        nextTrack: restartSummary?.nextTrack || null,
        clientCount: restartSummary?.audioClientCount ?? (session.mixer.clients?.size || 0),
        eventClientCount: restartSummary?.eventClientCount ?? (session.mixer.eventClients?.size || 0),
        streamAlive: true
      });
    }

    if (!isStreaming) {
      logSessionEvent('refresh_response', {
        stage: 'rebroadcast',
        sessionId: session.sessionId,
        streamAlive: false,
        note: 'inactive'
      }, { level: 'warn' });
      return res.status(200).json({ ok: false, reason: 'inactive', streamAlive: false });
    }

    // Explorer refresh is now done via POST /explorer - no longer broadcast via SSE
    // const forceExplorerUpdate = req.body.forceExplorerUpdate === true || req.body.forceExplorerRefresh === true;

    if (session.mixer.currentTrack && session.mixer.currentTrack.path) {
      console.log(`🔄 Triggering heartbeat for session ${session.sessionId} (${session.mixer.eventClients.size} clients)`);
      await session.mixer.broadcastHeartbeat('manual-refresh', { force: true });
      // Explorer snapshots now fetched via POST /explorer - no longer broadcast via SSE

      const currentTrack = session.mixer.currentTrack || summary?.currentTrack || null;
      const pendingTrack = session.mixer.pendingCurrentTrack || summary?.pendingTrack || null;
      const nextTrack = session.mixer.nextTrack || summary?.nextTrack || null;
      const lastBroadcast = summary?.lastBroadcast || (session.mixer.lastTrackEventPayload ? {
        timestamp: session.mixer.lastTrackEventTimestamp,
        trackId: session.mixer.lastTrackEventPayload.currentTrack?.identifier || null
      } : null);

      logSessionEvent('refresh_response', {
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
        fingerprint: fingerprintRegistry.getFingerprintForSession(session.sessionId)
      });
    }

    logSessionEvent('refresh_response', {
      stage: 'rebroadcast',
      sessionId: session.sessionId,
      note: 'no_track'
    });
    res.status(200).json({ ok: false, reason: 'no_track', streamAlive: true });

  } catch (error) {
    console.error('🔄 SSE refresh error:', error);
    logSessionEvent('refresh_response', {
      stage,
      sessionId: session?.sessionId || null,
      error: error?.message || String(error)
    }, { level: 'error' });
    res.status(500).json({ error: error.message });
  }
});

// Simplified SSE refresh endpoint (requests session from context)
app.post('/refresh-sse-simple', async (req, res) => {
  console.log('🔄 Simple SSE refresh request from client');

  try {
    const requestFingerprint = typeof req.body?.fingerprint === 'string'
      ? req.body.fingerprint.trim()
      : (typeof req.query?.fingerprint === 'string' ? req.query.fingerprint.trim() : null);

    let session = null;
    if (requestFingerprint) {
      const entry = fingerprintRegistry.lookup(requestFingerprint);
      if (entry) {
        session = getSessionById(entry.sessionId) || null;
        if (session) {
          fingerprintRegistry.touch(requestFingerprint, { metadataIp: req.ip });
        }
      }
    }

    if (!session) {
      session = await getSessionForRequest(req, { createIfMissing: false });
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

    if (session.mixer.currentTrack && session.mixer.currentTrack.path) {
      console.log(`🔄 Triggering heartbeat for session ${session.sessionId} (${session.mixer.eventClients.size} clients)`);
      await session.mixer.broadcastHeartbeat('manual-refresh-simple', { force: true });
      // Note: Explorer snapshots are now fetched via POST /explorer - SSE snapshots deprecated

      const currentTrack = session.mixer.currentTrack || summary?.currentTrack || null;
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
        fingerprint: fingerprintRegistry.getFingerprintForSession(session.sessionId)
      });
    } else {
      console.log(`🔄 Session ${session.sessionId} has no valid track to broadcast`);
      res.status(200).json({ ok: false, reason: 'no_track', streamAlive: true });
    }

  } catch (error) {
    console.error('🔄 Simple SSE refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Calculate total duration of stack (placeholder)
function calculateStackDuration(stack) {
  // TODO: Implement duration calculation
  // For now, estimate 3 minutes per track
  return stack.length * 180;
}

// Setup playlist routes (extracted to routes/playlist.js)
setupPlaylistRoutes(app, { pool, createSession, getSessionById, registerSession });

// Setup named session routes (extracted to routes/named-session.js)
setupNamedSessionRoutes(app, { getSessionById, unregisterSession, registerSession, createSession, calculateStackDuration });

// Setup API routes (extracted to routes/api.js)
setupApiRoutes(app, { pool, radialSearch });

// Setup VAE routes (extracted to routes/vae.js)
setupVaeRoutes(app, { vaeService, radialSearch });

// MD5-based journey endpoints
// Start journey from specific track: /md5 (SSE-driven)
app.get('/:md5', async (req, res, next) => {
  const md5 = req.params.md5;

  // Validate MD5 format (32-character hex string)
  if (!/^[a-f0-9]{32}$/.test(md5)) {
    return next();
  }

  const sessionId = md5; // Use MD5 as session ID
  console.log(`🎯 Starting SSE-driven journey from track MD5: ${md5} (session: ${sessionId})`);

  try {
    // Create or get session with MD5-based ID
    let session = getSessionById(sessionId);
    if (!session) {
      console.log(`Creating new session for MD5: ${sessionId}`);
      session = await createSession({ sessionId, autoStart: false, ephemeral: true });
      // Initialize as anonymous session with retroactive stack
      session.mixer.initializeSession('anonymous', sessionId);
    }

    // Ensure mixer is idle before seeding manual track
    if (session.mixer.stopStreaming) {
      session.mixer.stopStreaming();
    }

    session.mixer.isActive = false;
    session.mixer.nextTrack = null;
    if (typeof session.mixer.resetManualOverrideLock === 'function') {
      session.mixer.resetManualOverrideLock();
    } else {
      session.mixer.lockedNextTrackIdentifier = null;
      session.mixer.isUserSelectionPending = false;
    }

    // Get the track from the database
    const track = session.mixer.radialSearch.kdTree.getTrack(md5);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Seed the session with this track (streaming starts when client connects)
    session.mixer.currentTrack = track;
    session.mixer.trackStartTime = Date.now();

    console.log(`🎯 Session seeded with: ${track.title} by ${track.artist}`);

    await persistAudioSessionBinding(req, session.sessionId);

    return res.redirect('/');
  } catch (error) {
    console.error('MD5 journey start error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Contrived journey: start at md51 with md52 preloaded as next (SSE-driven)
app.get('/:md51/:md52', async (req, res, next) => {
  const { md51, md52 } = req.params;

  // Validate both MD5 formats
  if (!/^[a-f0-9]{32}$/.test(md51) || !/^[a-f0-9]{32}$/.test(md52)) {
    return next();
  }

  const sessionId = `${md51}_${md52}`; // Use combined MD5s as session ID
  console.log(`🎯 SSE-driven contrived journey: ${md51} → ${md52} (session: ${sessionId})`);

  try {
    // Create or get session with combined MD5-based ID
    let session = getSessionById(sessionId);
    if (!session) {
      console.log(`Creating new contrived session: ${sessionId}`);
      session = await createSession({ sessionId, autoStart: false, ephemeral: true });
      // Initialize as anonymous session with predefined two-track stack
      const initialStack = [
        { identifier: md51, direction: null, scope: 'magnify' },
        { identifier: md52, direction: null, scope: 'magnify' }
      ];
      session.mixer.initializeSession('anonymous', sessionId, initialStack);
    }

    if (session.mixer.stopStreaming) {
      session.mixer.stopStreaming();
    }

    session.mixer.isActive = false;
    session.mixer.nextTrack = null;
    if (typeof session.mixer.resetManualOverrideLock === 'function') {
      session.mixer.resetManualOverrideLock();
    } else {
      session.mixer.lockedNextTrackIdentifier = null;
      session.mixer.isUserSelectionPending = false;
    }

    // Get both tracks from the database
    const track1 = session.mixer.radialSearch.kdTree.getTrack(md51);
    const track2 = session.mixer.radialSearch.kdTree.getTrack(md52);

    if (!track1) {
      return res.status(404).json({ error: `First track not found: ${md51}` });
    }
    if (!track2) {
      return res.status(404).json({ error: `Second track not found: ${md52}` });
    }

    // Seed session with track1 and preload track2 (streaming starts when client connects)
    session.mixer.currentTrack = track1;
    session.mixer.trackStartTime = Date.now();
    if (typeof session.mixer.handleUserSelectedNextTrack === 'function') {
      session.mixer.handleUserSelectedNextTrack(md52, { debounceMs: 0 });
    } else if (typeof session.mixer.prepareNextTrackForCrossfade === 'function') {
      try {
        session.mixer.lockedNextTrackIdentifier = md52;
        if ('pendingUserOverrideTrackId' in session.mixer) {
          session.mixer.pendingUserOverrideTrackId = md52;
        }
        session.mixer.prepareNextTrackForCrossfade({
          forceRefresh: true,
          reason: 'user-selection',
          overrideTrackId: md52
        });
      } catch (legacyError) {
        console.warn('⚠️ Legacy mixer could not queue user-selected track:', legacyError?.message || legacyError);
      }
    } else {
      console.warn('⚠️ Legacy mixer lacks user override support; manual next-track unavailable.');
    }

    console.log(`🎯 Contrived journey seeded: ${track1.title} → ${track2.title}`);

    await persistAudioSessionBinding(req, session.sessionId);

    return res.redirect('/');
  } catch (error) {
    console.error('Contrived journey error:', error);
    res.status(500).json({ error: error.message });
  }
});


// Fuzzy search endpoint
app.get('/search', async (req, res) => {
  const rawQuery = req.query.q;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const normalizedQuery = query.toLowerCase();
  const limit = parseInt(req.query.limit) || 50;

  if (!normalizedQuery || normalizedQuery.length < 2) {
    return res.json({ results: [], query: query, total: 0 });
  }

  console.log(`🔍 Fuzzy search: "${query}" (limit: ${limit})`);

  // PostgreSQL trigram fuzzy search on music_analysis table
  const searchQuery = `
    SELECT
      identifier,
      bt_path,
      bt_title,
      bt_artist,
      bt_album,
      bt_year,
      similarity(path_keywords, $1) AS score
    FROM music_analysis
    WHERE path_keywords % $1
    ORDER BY score DESC
    LIMIT $2
  `;

  try {
    const client = await pool.connect();
    let result;
    try {
      result = await client.query(searchQuery, [normalizedQuery, limit]);
    } finally {
      client.release();
    }
    const rows = result.rows;

    const decodeBtPath = (btPath) => {
      if (btPath && btPath.startsWith('\\x')) {
        try {
          const hexString = btPath.slice(2);
          const buffer = Buffer.from(hexString, 'hex');
          return buffer.toString('utf8');
        } catch (error) {
          return btPath;
        }
      }
      return btPath;
    };

    const results = rows.map(row => {
      try {
        const decodedPath = decodeBtPath(row.bt_path);
        const filename = path.basename(decodedPath);
        const directory = path.dirname(decodedPath).replace('/Volumes/', '');

        // Parse path segments like: /Volumes/tranche/year/month/artist/album/title.mp3
        const pathParts = directory.split('/').filter(p => p);
        const segments = {
          tranche: pathParts[0] || '',
          year: pathParts[1] || '',
          month: pathParts[2] || '',
          pathArtist: pathParts[3] || '',
          pathAlbum: pathParts[4] || ''
        };

        return {
          md5: row.identifier,
          path: decodedPath,
          filename: filename,
          directory: directory,
          segments: pathParts.slice(3),  // ignore tranche, year, month
          albumCover: '/images/albumcover.png',
          title: row.bt_title || filename,
          artist: row.bt_artist || segments.pathArtist || '',
          album: row.bt_album || segments.pathAlbum || '',
          year: row.bt_year || segments.year || '',
          score: row.score,  // Similarity score 0.0-1.0
          displayText: `${row.bt_artist || segments.pathArtist || 'Unknown'} - ${row.bt_title || filename}`,
          searchableText: `${decodedPath} ${row.bt_artist || ''} ${row.bt_title || ''} ${row.bt_album || ''} ${segments.tranche} ${segments.year} ${segments.month}`
        };
      } catch (e) {
        console.error('Error processing row:', e);
        return null;
      }
    }).filter(Boolean);

    res.json({
      results: results,
      query: query,
      total: results.length,
      hasMore: results.length === limit
    });
  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/track/:identifier/meta', async (req, res) => {
  const { identifier } = req.params;
  if (!identifier) {
    return res.status(400).json({ error: 'missing identifier' });
  }

  try {
    let track = radialSearch.kdTree?.getTrack(identifier);

    if (!track) {
      const searchCollections = [audioSessions, ephemeralSessions];

      for (const collection of searchCollections) {
        for (const session of collection.values()) {
          const mixer = session?.mixer;
          if (!mixer) continue;

          try {
            if (mixer.currentTrack?.identifier === identifier) {
              track = mixer.hydrateTrackRecord(mixer.currentTrack);
              if (track) break;
            }

            if (mixer.nextTrack?.identifier === identifier) {
              track = mixer.hydrateTrackRecord(mixer.nextTrack);
              if (track) break;
            }

            if (typeof mixer.hydrateTrackRecord === 'function') {
              const hydrated = mixer.hydrateTrackRecord({ identifier });
              if (hydrated?.identifier === identifier) {
                track = hydrated;
                break;
              }
            }
          } catch (error) {
            console.warn('⚠️ Mixer hydration failed for track', identifier, error?.message || error);
          }
        }
        if (track) break;
      }
    }

    if (!track) {
      return res.status(404).json({ error: 'track not found' });
    }

    const payload = JSON.parse(JSON.stringify(track));
    return res.json({ track: payload });
  } catch (error) {
    console.error('Failed to fetch track metadata:', error);
    res.status(500).json({ error: 'failed to load track metadata' });
  }
});


// Main page - serves a UI with 3D visualization
app.get('/', async (req, res) => {
  try {
    await getSessionForRequest(req);
  } catch (error) {
    console.error('Failed to initialise session for root request:', error);
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Simplified status endpoint - resolves session from request context
app.get('/status', async (req, res) => {
    const session = await getSessionForRequest(req, { createIfMissing: true });

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    ...session.mixer.getStats(),
    created: session.created,
    lastAccess: session.lastAccess
  });
});

// Current track info (sentinel-driven track change — client fetches on sentinel)
app.get('/current-track', async (req, res) => {
  const session = await getSessionForRequest(req, { createIfMissing: false });
  if (!session?.mixer) return res.status(404).json({ error: 'No active session' });

  const payload = session.mixer.buildHeartbeatPayload('current-track-request');
  if (!payload?.currentTrack) return res.status(204).send();

  res.json({
    currentTrack: payload.currentTrack,
    timing: payload.timing,
    nextTrack: payload.nextTrack,
    override: payload.override,
    fingerprint: payload.fingerprint,
    driftState: payload.drift,
    currentTrackDirection: payload.currentTrackDirection
  });
});

// Session status (backward compatibility)
app.get('/status/:sessionId', (req, res) => {
  console.log(`⚠️ Deprecated status URL requested: /status/${req.params.sessionId}`);
  res.status(410).json({ error: 'Session-specific status URLs have been removed. Query /status instead.' });
});

// Radial search endpoints
app.post('/radial-search', async (req, res) => {
  try {
    const { trackId, config = {} } = req.body;

    if (!trackId) {
      return res.status(400).json({ error: 'trackId is required' });
    }

    const result = await radialSearch.exploreFromTrack(trackId, config);
    res.json(result);
  } catch (error) {
    console.error('Radial search error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/directional-search', async (req, res) => {
  try {
    const { trackId, direction, config = {} } = req.body;

    if (!trackId || !direction) {
      return res.status(400).json({ error: 'trackId and direction are required' });
    }

    const result = await radialSearch.getDirectionalCandidates(trackId, direction, config);
    res.json(result);
  } catch (error) {
    console.error('Directional search error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/radial-search/stats', (req, res) => {
  try {
    const stats = radialSearch.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// PCA-enhanced search endpoints
app.get('/pca/directions', (req, res) => {
  try {
    const directions = radialSearch.getPCADirections();
    res.json(directions);
  } catch (error) {
    console.error('PCA directions error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/pca/resolutions', (req, res) => {
  try {
    const resolutions = radialSearch.getResolutionSettings();
    res.json(resolutions);
  } catch (error) {
    console.error('PCA resolutions error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/pca/directional-search', async (req, res) => {
  try {
    const { trackId, pcaDomain, pcaComponent, direction, config = {} } = req.body;

    if (!trackId || !pcaDomain || !direction) {
      return res.status(400).json({ error: 'trackId, pcaDomain, and direction are required' });
    }

    const result = await radialSearch.getPCADirectionalCandidates(
      trackId, pcaDomain, pcaComponent || 'pc1', direction, config
    );
    res.json(result);
  } catch (error) {
    console.error('PCA directional search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dead endpoint - kept for backwards compatibility, returns empty response
app.post('/pca/explore', async (req, res) => {
  res.status(410).json({ error: 'This endpoint has been deprecated. Use POST /explorer instead.' });
});

/**
 * Strip heavy/unused fields from explorer data before sending to client.
 * Removes: features, pca, path, component, polarity, neighborhood stats, etc.
 */
function stripExplorerDataForClient(data, logLabel = 'explorer') {
  if (!data) return data;

  const beforeSize = JSON.stringify(data).length;

  // Strip track object - remove features/pca arrays but keep useful metadata
  const stripTrack = (track) => {
    if (!track) return track;
    const t = track.track || track;
    return {
      identifier: t.identifier || t.trackMd5,
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year,
      albumCover: t.albumCover,
      duration: t.duration || t.length,
      distance: track.distance || track.similarity
    };
  };

  // Strip direction - remove heavy fields but keep useful references
  const stripDirection = (dir, dirKey) => {
    if (!dir) return dir;
    if (!dir.direction) {
      serverLog.warn(`⚠️ stripDirection: missing .direction on ${dirKey} (domain=${dir.domain}, component=${dir.component}, polarity=${dir.polarity})`);
    }
    const stripped = {
      direction: dir.direction,
      domain: dir.domain,
      component: dir.component,    // e.g. 'pc1', 'energy', 'latent_0'
      polarity: dir.polarity,      // 'positive' or 'negative'
      sampleTracks: (dir.sampleTracks || []).map(stripTrack),
      trackCount: dir.trackCount || dir.sampleTracks?.length || 0,
      hasOpposite: dir.hasOpposite,
      isOutlier: dir.isOutlier,
      diversityScore: dir.diversityScore
    };
    // Include opposite direction if present (also stripped)
    if (dir.oppositeDirection) {
      const opp = dir.oppositeDirection;
      if (!opp.direction) {
        serverLog.warn(`⚠️ stripDirection: missing .direction on oppositeDirection of ${dirKey} (key=${opp.key}, domain=${opp.domain}, component=${opp.component}, polarity=${opp.polarity}, has keys: ${Object.keys(opp).join(',')})`);
      }
      stripped.oppositeDirection = {
        key: opp.key,
        direction: opp.direction,
        component: opp.component,
        polarity: opp.polarity,
        sampleTracks: (opp.sampleTracks || []).map(stripTrack),
        trackCount: opp.trackCount || opp.sampleTracks?.length || 0
      };
    }
    return stripped;
  };

  const result = {
    currentTrack: stripTrack(data.currentTrack),
    directions: {},
    nextTrack: data.nextTrack ? {
      directionKey: data.nextTrack.directionKey,
      direction: data.nextTrack.direction,
      track: stripTrack(data.nextTrack.track)
    } : null
  };

  // Strip each direction (skip empty directions)
  for (const [key, dir] of Object.entries(data.directions || {})) {
    if (dir.sampleTracks?.length > 0) {
      result.directions[key] = stripDirection(dir, key);
    }
  }

  const afterSize = JSON.stringify(result).length;
  const reduction = ((beforeSize - afterSize) / beforeSize * 100).toFixed(1);
  const dirCount = Object.keys(result.directions).length;
  const trackCount = Object.values(result.directions).reduce((sum, d) => sum + (d.sampleTracks?.length || 0), 0);
  serverLog.info(`📦 ${logLabel}: ${(beforeSize/1024).toFixed(1)}KB → ${(afterSize/1024).toFixed(1)}KB (-${reduction}%) [${dirCount} dirs, ${trackCount} tracks]`);

  return result;
}

// New explorer endpoint - request/response model for playlist-aware exploration
// Replaces SSE-based explorer snapshot broadcasts
app.post('/explorer', async (req, res) => {
  const startTime = Date.now();
  serverLog.info(`🎯 Explorer request received: ${JSON.stringify(req.body)}`);
  try {
    const { trackId, sessionId, playlistTrackIds = [], fingerprint: requestFingerprint } = req.body;

    if (!trackId) {
      serverLog.warn('🎯 Explorer request missing trackId');
      return res.status(400).json({ error: 'trackId is required' });
    }
    serverLog.info(`🎯 Explorer request for trackId: ${trackId.substring(0, 8)}`);


    // Resolve session from fingerprint or sessionId
    let session = null;
    if (typeof requestFingerprint === 'string' && requestFingerprint.trim()) {
      const entry = fingerprintRegistry.lookup(requestFingerprint.trim());
      if (entry) {
        session = getSessionById(entry.sessionId) || null;
        fingerprintRegistry.touch(requestFingerprint.trim(), { metadataIp: req.ip });
      }
    }
    if (!session && sessionId) {
      session = getSessionById(sessionId) || null;
    }

    // Build track lookup set for playlist filtering
    const playlistTrackSet = new Set(Array.isArray(playlistTrackIds) ? playlistTrackIds : []);

    // Get artists/albums from playlist tracks for deprioritization
    const playlistArtists = new Set();
    const playlistAlbums = new Set();
    for (const pid of playlistTrackSet) {
      const trackData = radialSearch.kdTree?.getTrack(pid);
      if (trackData) {
        if (trackData.artist) playlistArtists.add(trackData.artist.toLowerCase());
        if (trackData.album) playlistAlbums.add(trackData.album.toLowerCase());
      }
    }

    // Get the track we're exploring from (not necessarily the currently playing track)
    const sourceTrack = radialSearch.kdTree?.getTrack(trackId);
    if (!sourceTrack) {
      serverLog.warn(`🎯 Track not found: ${trackId}`);
      return res.status(404).json({ error: 'Track not found' });
    }
    serverLog.info(`🎯 Exploring from track: ${sourceTrack.title} by ${sourceTrack.artist}`);

    // Build explorer data — always use the mixer's comprehensive pipeline
    let explorerData;
    const isSameTrack = session?.mixer?.currentTrack?.identifier === sourceTrack?.identifier;
    if (session?.mixer) {
      serverLog.info(`🎯 Using session mixer for explorer data (trackId=${trackId.substring(0,8)}, isSameTrack=${isSameTrack})`);
      explorerData = await session.mixer.getComprehensiveExplorerData({
        trackId: sourceTrack.identifier,
        forceFresh: !isSameTrack
      });
    } else {
      // No session — truly standalone (rare: direct API call without active session)
      serverLog.info(`🎯 No session available, using standalone radial search for explorer data`);
      const rawExplorer = await radialSearch.exploreFromTrack(trackId, { usePCA: true });
      const rawOptionCount = Object.keys(rawExplorer.directionalOptions || {}).length;
      serverLog.info(`🎯 Standalone: ${rawOptionCount} directional options (fallback path)`);
      // Minimal conversion for the no-session edge case
      const convertedDirections = {};
      for (const [dimName, dimData] of Object.entries(rawExplorer.directionalOptions || {})) {
        const posCandidates = dimData.positive?.candidates || dimData.positive || [];
        const negCandidates = dimData.negative?.candidates || dimData.negative || [];
        for (const pole of [
          { key: `${dimName}_positive`, candidates: posCandidates, polarity: 'positive' },
          { key: `${dimName}_negative`, candidates: negCandidates, polarity: 'negative' }
        ]) {
          if (pole.candidates.length > 0) {
            convertedDirections[pole.key] = {
              direction: dimName,
              description: dimData.contextLabel || dimName,
              domain: 'original',
              component: dimName,
              polarity: pole.polarity,
              sampleTracks: pole.candidates.map(sample => {
                const track = sample.track || sample;
                return {
                  identifier: track.identifier,
                  title: track.title,
                  artist: track.artist,
                  albumCover: track.albumCover,
                  duration: track.length || track.duration,
                  distance: sample.distance || sample.similarity,
                  features: track.features
                };
              }),
              trackCount: pole.candidates.length
            };
          }
        }
      }
      // Deduplicate: each track appears in only one direction stack (first occurrence wins)
      const assignedTrackIds = new Set();
      for (const [dirKey, direction] of Object.entries(convertedDirections)) {
        direction.sampleTracks = direction.sampleTracks.filter(t => {
          const id = t.identifier;
          if (!id || assignedTrackIds.has(id)) return false;
          assignedTrackIds.add(id);
          return true;
        });
        direction.trackCount = direction.sampleTracks.length;
      }
      serverLog.info(`🎯 Standalone dedup: ${assignedTrackIds.size} unique tracks across ${Object.keys(convertedDirections).length} directions`);

      explorerData = {
        directions: convertedDirections,
        currentTrack: rawExplorer.currentTrack,
        diagnostics: { mode: 'standalone' }
      };
    }

    serverLog.info(`🎯 Explorer data has ${Object.keys(explorerData.directions || {}).length} directions before filtering`);

    // Filter and deprioritize directions based on playlist
    const filteredDirections = {};
    for (const [dirKey, direction] of Object.entries(explorerData.directions || {})) {
      if (!direction.sampleTracks || !Array.isArray(direction.sampleTracks)) {
        filteredDirections[dirKey] = direction;
        continue;
      }

      // Filter out playlist tracks, deprioritize playlist artists
      const prioritized = [];
      const deprioritized = [];

      for (const sample of direction.sampleTracks) {
        const track = sample.track || sample;
        const trackIdentifier = track.identifier || track.trackMd5;

        // Skip tracks already in playlist
        if (playlistTrackSet.has(trackIdentifier)) {
          continue;
        }

        // Deprioritize artists/albums from playlist
        const artistLower = (track.artist || '').toLowerCase();
        const albumLower = (track.album || '').toLowerCase();
        const isDeprioritized = playlistArtists.has(artistLower) || playlistAlbums.has(albumLower);

        if (isDeprioritized) {
          deprioritized.push(sample);
        } else {
          prioritized.push(sample);
        }
      }

      filteredDirections[dirKey] = {
        ...direction,
        sampleTracks: [...prioritized, ...deprioritized],
        trackCount: prioritized.length + deprioritized.length,
        filteredCount: direction.sampleTracks.length - (prioritized.length + deprioritized.length)
      };
    }

    // Diagnostic: log filtered directions status
    const filteredDirSummary = Object.entries(filteredDirections).map(([k, d]) => ({
      key: k,
      trackCount: d.sampleTracks?.length || 0,
      diversityScore: d.diversityScore
    }));
    serverLog.info(`🎯 Filtered directions: ${JSON.stringify(filteredDirSummary)}`);

    // Pick recommended next track from filtered directions
    let nextTrack = null;
    if (explorerData.nextTrack) {
      // Mixer returns flat format (identifier on root), normalize to nested { directionKey, direction, track }
      const rawNext = explorerData.nextTrack;
      const recKey = rawNext.directionKey;
      const recTrackId = rawNext.track?.identifier || rawNext.identifier;
      const dirHasTracks = filteredDirections[recKey]?.sampleTracks?.length > 0;
      serverLog.info(`🎯 Mixer recommended: dirKey=${recKey}, trackId=${recTrackId?.substring(0,8)}, inFiltered=${!!filteredDirections[recKey]}, hasTracks=${dirHasTracks}, inPlaylist=${playlistTrackSet.has(recTrackId)}`);
      if (recKey && dirHasTracks && !playlistTrackSet.has(recTrackId)) {
        nextTrack = {
          directionKey: recKey,
          direction: rawNext.direction,
          track: rawNext.track || {
            identifier: rawNext.identifier,
            title: rawNext.title,
            artist: rawNext.artist,
            album: rawNext.album,
            albumCover: rawNext.albumCover,
            duration: rawNext.duration || rawNext.length
          }
        };
      }
    } else {
      serverLog.info(`🎯 No mixer recommendation (explorerData.nextTrack is falsy)`);
    }
    // Fallback: pick first track from highest-diversity direction
    if (!nextTrack) {
      const sortedDirs = Object.entries(filteredDirections)
        .filter(([_, dir]) => dir.sampleTracks && dir.sampleTracks.length > 0)
        .sort((a, b) => (b[1].diversityScore || 0) - (a[1].diversityScore || 0));
      serverLog.info(`🎯 Fallback: ${sortedDirs.length} directions with tracks after filter`);
      if (sortedDirs.length > 0) {
        const [dirKey, dir] = sortedDirs[0];
        const firstTrack = dir.sampleTracks[0];
        serverLog.info(`🎯 Fallback picked: ${dirKey} with track ${firstTrack?.identifier?.substring(0,8)}`);
        nextTrack = {
          directionKey: dirKey,
          direction: dir.direction,
          track: firstTrack
        };
      } else {
        serverLog.warn(`🎯 Fallback found no directions with tracks!`);
      }
    }

    // Reconcile explorer recommendation with what the mixer has prepared.
    // If the mixer already has a next track loaded, the client must see THAT track
    // (not a fresh computation that may differ). Otherwise store the recommendation
    // so crossfade prep can honor it later.
    const currentTrackId = session?.mixer?.currentTrack?.identifier;
    const preparedNextId = session?.mixer?.nextTrack?.identifier;
    const explorerNextId = nextTrack?.track?.identifier;
    const isPreparationInProgress = session?.mixer?._preparationInProgress || session?.mixer?.pendingPreparationPromise;

    if (session?.mixer && explorerNextId && trackId === currentTrackId) {
      if (preparedNextId && preparedNextId !== explorerNextId && preparedNextId !== currentTrackId) {
        // Mixer already has a different track prepared — override the response
        // so the client displays what will actually play, not a stale recommendation.
        const preparedTrack = session.mixer.nextTrack;
        const preparedDirection = preparedTrack?.direction || preparedTrack?.transitionDirection || null;
        const preparedDirKey = preparedTrack?.directionKey || preparedTrack?.transitionDirectionKey || null;
        serverLog.info(`📌 Explorer recommends ${explorerNextId?.substring(0,8)} but mixer has ${preparedNextId?.substring(0,8)} prepared — overriding response`);
        nextTrack = {
          directionKey: preparedDirKey,
          direction: preparedDirection,
          track: {
            identifier: preparedTrack.identifier,
            title: preparedTrack.title,
            artist: preparedTrack.artist,
            album: preparedTrack.album,
            albumCover: preparedTrack.albumCover,
            duration: preparedTrack.duration || preparedTrack.length
          }
        };
      } else if (preparedNextId && preparedNextId === currentTrackId) {
        // Mixer has stale data — its "next track" is the current track. Ignore it.
        serverLog.warn(`📌 Mixer nextTrack ${preparedNextId?.substring(0,8)} === currentTrack — ignoring stale mixer state`);
        // Don't overwrite explorerRecommendedNext — the prepared track takes precedence
      } else if (preparedNextId && preparedNextId === explorerNextId) {
        // Recommendation matches the already-prepared next track — no need to store
        serverLog.info(`📌 Explorer recommendation ${explorerNextId?.substring(0,8)} matches prepared next — not storing (would cause repeat)`);
      } else {
        // No prepared track — store the recommendation
        session.mixer.explorerRecommendedNext = {
          trackId: explorerNextId,
          direction: nextTrack.direction,
          directionKey: nextTrack.directionKey,
          track: nextTrack.track
        };
        serverLog.info(`📌 Stored explorer recommendation: ${explorerNextId?.substring(0,8)}`);
      }
    } else if (session?.mixer && explorerNextId) {
      serverLog.info(`📌 Skipping explorer recommendation store: exploring from ${trackId?.substring(0,8)}, current is ${currentTrackId?.substring(0,8)}`);
    }

    // Only trigger preparation if the mixer has NO next track at all.
    if (session?.mixer && explorerNextId && !preparedNextId && !isPreparationInProgress) {
      serverLog.info(`🔄 Explorer filling empty next slot: ${explorerNextId?.substring(0,8)}`);
      session.mixer.prepareNextTrackForCrossfade({
        forceRefresh: false,
        reason: 'explorer-fill',
        overrideTrackId: explorerNextId,
        overrideDirection: nextTrack.direction
      }).catch(err => {
        serverLog.warn(`⚠️ Explorer-fill preparation failed: ${err?.message || err}`);
      });
    }

    // Build response and strip heavy fields before sending
    const rawResponse = {
      directions: filteredDirections,
      currentTrack: sourceTrack,
      nextTrack
    };

    const response = stripExplorerDataForClient(rawResponse);

    // TEMP DIAGNOSTIC: Check opposite direction data in stripped response
    const oppositeDiag = Object.entries(response.directions || {}).map(([k, d]) => {
      const oppTracks = d.oppositeDirection?.sampleTracks?.length || 0;
      return `${k}:hasOpp=${d.hasOpposite},oppTracks=${oppTracks}`;
    });
    serverLog.info(`🔄 OPPOSITE DIAG: ${oppositeDiag.join(' | ')}`);

    // Validate response matches contract before sending
    const undefinedDirs = Object.entries(response.directions || {})
      .filter(([, v]) => !v || typeof v.direction !== 'string')
      .map(([k, v]) => `${k}: direction=${v?.direction}, domain=${v?.domain}`);
    if (undefinedDirs.length > 0) {
      serverLog.warn(`🔍 Directions with undefined .direction field: ${undefinedDirs.join(' | ')}`);
    }
    validateOrWarn(ExplorerResponse, response, `explorer:${trackId.substring(0, 8)}`);

    serverLog.info(`🎯 Explorer request for ${trackId.substring(0, 8)} completed in ${Date.now() - startTime}ms`);
    res.json(response);

  } catch (error) {
    console.error('Explorer endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});


// Reset drift for a session
app.post('/session/reset-drift', async (req, res) => {
  const session = await getSessionForRequest(req, { createIfMissing: false });

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    if (session.mixer.resetDrift) {
      session.mixer.resetDrift();
      res.json({ message: 'Drift reset successfully' });
    } else {
      res.status(400).json({ error: 'Session does not support drift reset' });
    }
  } catch (error) {
    console.error('Drift reset error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/session/:sessionId/reset-drift', (req, res) => {
  console.log(`⚠️ Deprecated reset-drift URL requested: /session/${req.params.sessionId}/reset-drift`);
  res.status(410).json({ error: 'Session-specific control URLs have been removed. Use /session/reset-drift instead.' });
});

// User directional command
app.post('/session/flow/:direction', async (req, res) => {
  const direction = req.params.direction;
  const session = await getSessionForRequest(req, { createIfMissing: false });

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    if (session.mixer.triggerDirectionalFlow) {
      console.log(`🎛️ User triggered: ${direction}`);
      session.mixer.triggerDirectionalFlow(direction);
      res.json({ message: `Flowing ${direction}`, direction });
    } else {
      res.status(400).json({ error: 'Session does not support directional flow' });
    }
  } catch (error) {
    console.error('Directional flow error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/session/:sessionId/flow/:direction', (req, res) => {
  console.log(`⚠️ Deprecated flow URL requested: /session/${req.params.sessionId}/flow/${req.params.direction}`);
  res.status(410).json({ error: 'Session-specific control URLs have been removed. Use /session/flow/:direction instead.' });
});

// Force immediate track change (test command)
app.post('/session/force-next', async (req, res) => {
  const session = await getSessionForRequest(req, { createIfMissing: false });

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    console.log(`🎮 Force next track for session ${session.sessionId}`);

    if (session.mixer.triggerGaplessTransition) {
      session.mixer.triggerGaplessTransition();
      res.json({ message: 'Track change forced' });
    } else {
      res.status(400).json({ error: 'Session does not support forced transitions' });
    }
  } catch (error) {
    console.error('Force next error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/session/:sessionId/force-next', (req, res) => {
  console.log(`⚠️ Deprecated force-next URL requested: /session/${req.params.sessionId}/force-next`);
  res.status(410).json({ error: 'Session-specific control URLs have been removed. Use /session/force-next instead.' });
});

// Zoom mode command (legacy aliases now converge on adaptive tuning)
app.post('/session/zoom/:mode', async (req, res) => {
  const mode = req.params.mode;
  const session = await getSessionForRequest(req, { createIfMissing: false });

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const supportedModes = ['adaptive', 'auto', 'microscope', 'magnifying', 'binoculars'];
  if (!supportedModes.includes(mode)) {
    return res.status(400).json({ error: 'Invalid zoom mode' });
  }

  try {
    console.log(`🔍 Zoom mode request '${mode}' for session ${session.sessionId}`);

    if (!session.mixer.setExplorerResolution) {
      return res.status(400).json({ error: 'Session does not support zoom controls' });
    }

    const normalizedMode = mode === 'auto' ? 'adaptive' : mode;
    const changed = session.mixer.setExplorerResolution(normalizedMode);

    const deprecated = ['microscope', 'magnifying', 'binoculars'].includes(mode);

    if (changed) {
      await session.mixer.broadcastHeartbeat('zoom-change', { force: false });
      // Note: Explorer snapshots are now fetched via POST /explorer - SSE snapshots deprecated
    }

    const modeEmoji = {
      'adaptive': '🧭',
      'auto': '🧭',
      'microscope': '🔬',
      'magnifying': '🔍',
      'binoculars': '🔭'
    };

    const emoji = modeEmoji[normalizedMode] || modeEmoji[mode] || '';

    res.json({
      message: deprecated
        ? `${emoji} Adaptive explorer tuning is now automatic`
        : `${emoji} Adaptive explorer tuning confirmed`,
      mode: 'adaptive',
      requestedMode: mode,
      sessionId: session.sessionId,
      resolution: session.mixer.explorerResolution,
      broadcast: changed,
      deprecated
    });
  } catch (error) {
    console.error('Zoom mode error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/session/:sessionId/zoom/:mode', (req, res) => {
  console.log(`⚠️ Deprecated zoom URL requested: /session/${req.params.sessionId}/zoom/${req.params.mode}`);
  res.status(410).json({ error: 'Session-specific control URLs have been removed. Use /session/zoom/:mode instead.' });
});

// Simplified next track endpoint - resolves session from request context
app.post('/next-track', async (req, res) => {
  const {
    trackMd5,
    direction,
    source = 'user',
    origin = null,
    explorerSignature = null, // Reserved for future validation
    fingerprint: requestFingerprint
  } = req.body;
  const normalizedSource = typeof source === 'string' ? source.toLowerCase() : 'user';
  const normalizedOrigin = typeof origin === 'string' ? origin.toLowerCase() : null;

  if (!trackMd5) {
    return res.status(400).json({ error: 'Track MD5 is required' });
  }

  let session = null;

  if (typeof requestFingerprint === 'string' && requestFingerprint.trim()) {
    const entry = fingerprintRegistry.lookup(requestFingerprint.trim());
    if (!entry) {
      return res.status(404).json({ error: 'Fingerprint not found' });
    }
    session = getSessionById(entry.sessionId) || null;
    if (!session) {
      return res.status(404).json({ error: 'Session not found for fingerprint' });
    }
    fingerprintRegistry.touch(requestFingerprint.trim(), { metadataIp: req.ip });
  } else {
    session = await getSessionForRequest(req, { createIfMissing: false });
  }

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    const cleanMd5 = typeof trackMd5 === 'string' ? trackMd5 : null;
    const advertisedDirection = typeof direction === 'string' ? direction : null;
    const isDeckSelection = normalizedSource === 'user' && normalizedOrigin === 'deck';

    let deckMatch = null;
    if (isDeckSelection) {
      const lastExplorer = session.mixer.lastExplorerSnapshotPayload?.explorer || null;
      deckMatch = findTrackInExplorerSnapshot(lastExplorer, cleanMd5);
    }

    if (isDeckSelection && deckMatch) {
      const deckDirection = advertisedDirection || deckMatch.directionKey || null;
      const hydrated = session.mixer.hydrateTrackRecord(deckMatch.track || cleanMd5, {
        direction: deckDirection,
        transitionReason: 'deck-selection'
      });

      if (hydrated && hydrated.identifier) {
        if (session.mixer.nextTrack?.identifier !== hydrated.identifier) {
          try {
            await session.mixer.prepareNextTrackForCrossfade({
              forceRefresh: true,
              reason: 'deck-selection',
              overrideTrackId: hydrated.identifier,
              overrideDirection: deckDirection
            });
          } catch (prepErr) {
            console.warn('⚠️ Deck selection preparation failed:', prepErr?.message || prepErr);
            session.mixer.nextTrack = hydrated;
          }
        }

        session.mixer.nextTrack = session.mixer.nextTrack || hydrated;
        if (typeof session.mixer.clearPendingUserSelection === 'function') {
          session.mixer.clearPendingUserSelection();
        } else {
          session.mixer.pendingUserOverrideTrackId = null;
          session.mixer.pendingUserOverrideDirection = null;
          session.mixer.isUserSelectionPending = false;
        }
        session.mixer.lockedNextTrackIdentifier = hydrated.identifier;

        if (typeof session.mixer.broadcastSelectionEvent === 'function') {
          session.mixer.broadcastSelectionEvent('selection_ack', {
            status: 'promoted',
            trackId: cleanMd5,
            direction: deckDirection,
            origin: 'deck'
          });
        }

        const durationMs = session.mixer.getAdjustedTrackDuration() * 1000;
        const elapsed = session.mixer.trackStartTime ? (Date.now() - session.mixer.trackStartTime) : 0;
        const remainingMs = Math.max(0, durationMs - elapsed);

        const currentTrackId = session.mixer.currentTrack?.identifier || null;
        const preparedNextId = session.mixer.nextTrack?.identifier || null;
        const pendingCurrentId = session.mixer.pendingCurrentTrack?.identifier || null;

        console.log(`📤 /next-track deck promotion: ${cleanMd5?.substring(0,8) || 'none'} via ${deckDirection || 'unknown'}`);

        return res.json({
          status: 'deck_ack',
          origin: 'deck',
          sessionId: session.sessionId,
          fingerprint: fingerprintRegistry.getFingerprintForSession(session.sessionId),
          currentTrack: currentTrackId,
          nextTrack: preparedNextId,
          pendingTrack: pendingCurrentId,
          trackId: cleanMd5,
          direction: deckDirection,
          duration: Math.round(durationMs),
          remaining: Math.round(remainingMs)
        });
      }

      console.warn(`⚠️ Deck selection hydrate failed for ${cleanMd5}; falling back to override flow`);
    }

    if (isDeckSelection) {
      console.warn(`🎯 Deck selection for ${cleanMd5} not found in current explorer data; treating as override`);
    }

    if (normalizedSource === 'user') {
      const originLabel = normalizedOrigin ? `/${normalizedOrigin}` : '';
      console.log(`🎯 User selected specific track${originLabel}: ${trackMd5} (direction: ${direction})`);

      if (typeof session.mixer.handleUserSelectedNextTrack === 'function') {
        await session.mixer.handleUserSelectedNextTrack(trackMd5, { direction });
      } else if (typeof session.mixer.setNextTrack === 'function') {
        session.mixer.setNextTrack(trackMd5);
      } else if (typeof session.mixer.prepareNextTrackForCrossfade === 'function') {
        if (direction && session.mixer.driftPlayer) {
          session.mixer.driftPlayer.currentDirection = direction;
        }
        if ('pendingUserOverrideTrackId' in session.mixer) {
          session.mixer.pendingUserOverrideTrackId = trackMd5;
        }
        session.mixer.lockedNextTrackIdentifier = trackMd5;
        await session.mixer.prepareNextTrackForCrossfade({
          forceRefresh: true,
          reason: 'user-selection',
          overrideTrackId: trackMd5,
          overrideDirection: direction || null
        });
      }
    } else {
      const serverNextTrack = session.mixer.nextTrack?.identifier || null;

      console.log(`💓 Heartbeat sync request received (clientNext=${cleanMd5?.substring(0,8) || 'none'}, direction=${advertisedDirection || 'unknown'})`);

      if (cleanMd5 && serverNextTrack && cleanMd5 !== serverNextTrack) {
        console.warn('💓 HEARTBEAT next-track mismatch', {
          clientNext: cleanMd5,
          serverNext: serverNextTrack,
          direction: advertisedDirection
        });
      }
    }

    // Calculate timing info for sync check
    const duration = session.mixer.getAdjustedTrackDuration() * 1000; // Convert to ms
    const elapsed = session.mixer.trackStartTime ? (Date.now() - session.mixer.trackStartTime) : 0;
    const remaining = Math.max(0, duration - elapsed);

    const currentTrackId = session.mixer.currentTrack?.identifier || null;
    const preparedNextId = session.mixer.nextTrack?.identifier || null;
    const pendingCurrentId = session.mixer.pendingCurrentTrack?.identifier || null;

    console.log(`📤 /next-track response (${normalizedSource}): current=${currentTrackId?.substring(0,8) || 'none'}, pending=${pendingCurrentId?.substring(0,8) || 'none'}, serverNext=${preparedNextId?.substring(0,8) || 'none'}, remaining=${Math.round(remaining)}ms`);

    const responsePayload = {
      status: normalizedSource === 'user' ? 'locked' : 'ok',
      origin: normalizedOrigin || null,
      sessionId: session.sessionId,
      fingerprint: fingerprintRegistry.getFingerprintForSession(session.sessionId),
      currentTrack: currentTrackId,
      nextTrack: preparedNextId,
      pendingTrack: pendingCurrentId,
      duration: Math.round(duration),
      remaining: Math.round(remaining)
    };

    if (normalizedSource === 'user') {
      responsePayload.trackId = cleanMd5 || null;
      responsePayload.direction = advertisedDirection || session.mixer.pendingUserOverrideDirection || null;
      responsePayload.origin = normalizedOrigin || responsePayload.origin;
    }

    res.json(responsePayload);
  } catch (error) {
    console.error('Next track selection error:', error);
    if (normalizedSource === 'user' && session?.mixer) {
      session.mixer.broadcastSelectionEvent('selection_failed', {
        status: 'failed',
        trackId: trackMd5,
        reason: error?.message || 'request_failed'
      });
    }
    res.status(500).json({ error: error.message });
  }
});

app.post('/session/:sessionId/next-track', (req, res) => {
  console.log(`⚠️ Deprecated next-track URL requested: /session/${req.params.sessionId}/next-track`);
  res.status(410).json({ error: 'Session-specific control URLs have been removed. Use /next-track instead.' });
});

// Create brand new random journey session (ephemeral)
app.post('/session/random', async (req, res) => {
  try {
    const session = await createSession({ autoStart: true, ephemeral: true });
    const mixer = session.mixer;

    const publicSessionId = mixer.currentTrack?.identifier || session.sessionId;
    if (publicSessionId !== session.sessionId) {
      unregisterSession(session.sessionId);
      session.sessionId = publicSessionId;
      session.mixer.sessionId = publicSessionId;
      registerSession(publicSessionId, session, { ephemeral: true });
      attachEphemeralCleanup(publicSessionId, session);
    }

    await persistAudioSessionBinding(req, publicSessionId);

    res.json({
      sessionId: publicSessionId,
      streamUrl: '/stream',
      eventsUrl: '/events',
      webUrl: '/',
      currentTrack: mixer.currentTrack ? {
        identifier: mixer.currentTrack.identifier,
        title: mixer.currentTrack.title,
        artist: mixer.currentTrack.artist
      } : null
    });
  } catch (error) {
    console.error('Failed to create random journey session:', error);
    res.status(500).json({ error: 'Failed to create random journey' });
  }
});

// Health endpoint with detailed session info
app.get('/health', (req, res) => {
  const sessionDetails = {};

  for (const [sessionId, session] of audioSessions) {
    const sessionHistory = session.mixer.sessionHistory || [];
    const currentTrack = session.mixer.currentTrack;
    const nextTrack = session.mixer.nextTrack;

    sessionDetails[sessionId] = {
      clients: session.mixer.clients ? session.mixer.clients.size : 0,
      isActive: session.mixer.isActive || false,
      created: session.created,
      lastAccess: session.lastAccess,
      currentTrack: currentTrack ? {
        title: currentTrack.title,
        artist: currentTrack.artist,
        identifier: currentTrack.identifier,
        md5: currentTrack.md5,
        path: currentTrack.path,
        startTime: session.mixer.trackStartTime
      } : null,
      nextTrack: nextTrack ? {
        title: nextTrack.title,
        artist: nextTrack.artist,
        identifier: nextTrack.identifier,
        md5: nextTrack.md5,
        path: nextTrack.path
      } : null,
      historyCount: sessionHistory.length,
      recentHistory: sessionHistory.slice(-5).map(track => ({
        title: track.title,
        artist: track.artist,
        direction: track.direction,
        startTime: track.startTime
      }))
    };
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: audioSessions.size,
    sessionDetails: sessionDetails,
    radialSearch: radialSearch.getStats()
  });
});

const { buildNowPlayingSessions } = require('./routes/nowPlaying');

app.get('/sessions/now-playing', (req, res) => {
  const sessions = buildNowPlayingSessions(audioSessions, ephemeralSessions, { now: Date.now() });
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    sessions
  });
});

app.get('/internal/metrics', (req, res) => {
  const snapshot = internalMetrics.getMetricsSnapshot({
    sessions: {
      active: audioSessions.size,
      ephemeral: ephemeralSessions.size
    },
    radialSearch: radialSearch.getStats(),
    adaptiveRadius: internalMetrics.summarizeAdaptiveRadius(audioSessions, ephemeralSessions)
  });
  res.json(snapshot);
});

app.get('/internal/sessions', (req, res) => {
  const summaries = internalMetrics.collectSessions(audioSessions, ephemeralSessions);
  const limit = Number(req.query.limit);
  const payload = Number.isFinite(limit) && limit > 0 ? summaries.slice(0, limit) : summaries;
  res.json({
    timestamp: Date.now(),
    count: summaries.length,
    sessions: payload
  });
});

app.get('/internal/logs/recent', (req, res) => {
  const limit = Number(req.query.limit);
  const entries = internalMetrics.getRecentLogs({
    channel: req.query.channel,
    level: req.query.level,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 100
  });
  res.json({
    timestamp: Date.now(),
    count: entries.length,
    entries
  });
});

app.get('/internal/sessions/:sessionId/events', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = getSessionById(sessionId);
  if (!session || !session.mixer) {
    return res.status(404).json({ error: 'Session not found' });
  }
  const limit = Number(req.query.limit);
  const events = Array.isArray(session.mixer.sessionEvents) ? session.mixer.sessionEvents : [];
  const payload = Number.isFinite(limit) && limit > 0 ? events.slice(-limit) : events;
  res.json({
    sessionId,
    timestamp: Date.now(),
    count: payload.length,
    events: payload
  });
});

// Session control endpoints (legacy compatibility)
app.post('/session/seek', async (req, res) => {
  const session = await getSessionForRequest(req, { createIfMissing: false });

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.status(501).json({ error: 'Seek control not implemented for this session' });
});

app.post('/session/:sessionId/seek', (req, res) => {
  console.log(`⚠️ Deprecated seek URL requested: /session/${req.params.sessionId}/seek`);
  res.status(410).json({ error: 'Session-specific control URLs have been removed. Use /session/seek instead.' });
});

let serverInstance = null;
let cleanupTimer = null;
let hasRegisteredSigintHandler = false;

function startServer() {
  if (serverInstance) {
    return serverInstance;
  }

  checkSingleton();

  cleanupTimer = setInterval(() => {
    const now = new Date();
    const timeout = 60 * 60 * 1000; // 60 minutes (longer for smart reconnection)

    for (const [sessionId, session] of audioSessions) {
      // Don't clean up sessions with active connections or recent activity
      const hasActiveAudioClients = session.mixer.clients && session.mixer.clients.size > 0;
      const hasActiveEventClients = session.mixer.eventClients && session.mixer.eventClients.size > 0;
      const isActiveStreaming = session.mixer.isActive;
      const hasRecentActivity = (now - session.lastAccess) < timeout;

      // Keep session alive if it still looks healthy to clients
      if (hasActiveAudioClients || hasActiveEventClients || isActiveStreaming || hasRecentActivity) {
        continue;
      }

      console.log(`🧹 Cleaning up inactive session: ${sessionId} (idle: ${Math.round((now - session.lastAccess) / 60000)}m)`);
      session.mixer.destroy();
      audioSessions.delete(sessionId);
    }
  }, 60 * 1000); // Check every minute

  if (!hasRegisteredSigintHandler) {
    process.on('SIGINT', () => {
      console.log('Shutting down gracefully...');

      for (const [sessionId, session] of audioSessions) {
        console.log(`Destroying session: ${sessionId}`);
        session.mixer.destroy();
      }

      radialSearch.close();
      
      // Cleanup VAE service
      if (vaeService && typeof vaeService.shutdown === 'function') {
        vaeService.shutdown().catch(console.error);
      }

      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }

      if (serverInstance) {
        serverInstance.close(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
    hasRegisteredSigintHandler = true;
  }

  const tlsKeyPath = path.join(__dirname, 'certs', 'key.pem');
  const tlsCertPath = path.join(__dirname, 'certs', 'cert.pem');
  const hasTLS = fs.existsSync(tlsKeyPath) && fs.existsSync(tlsCertPath);

  if (hasTLS) {
    const tlsOptions = {
      key: fs.readFileSync(tlsKeyPath),
      cert: fs.readFileSync(tlsCertPath)
    };
    serverInstance = https.createServer(tlsOptions, app).listen(port, () => {
      console.log(`🎵 Audio streaming server listening at https://localhost:${port}`);
      console.log('🎯 PCM mixer engaged - streaming directly from Node.js');
      console.log(`🔒 Server protected by PID ${process.pid} (TLS enabled)`);
    });
  } else {
    serverInstance = app.listen(port, () => {
      console.log(`🎵 Audio streaming server listening at http://localhost:${port}`);
      console.log('🎯 PCM mixer engaged - streaming directly from Node.js');
      console.log(`🔒 Server protected by PID ${process.pid} (no TLS)`);
      console.warn('⚠️ AudioWorklet requires HTTPS - place certs in certs/key.pem and certs/cert.pem');
    });
  }

  serverInstance.on('close', () => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  });

  // Handle port conflicts gracefully
  serverInstance.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ PORT CONFLICT: Port ${port} is already in use!`);
      console.error('❌ Another server instance may be running');
      console.error(`❌ Check: lsof -i :${port} or kill existing processes`);

      // Clean up our PID file since we failed to start
      try {
        if (fs.existsSync(pidFile)) {
          fs.unlinkSync(pidFile);
          console.log('🧹 Cleaned up PID file after port conflict');
        }
      } catch (cleanupErr) {
        console.error('Error cleaning up PID file:', cleanupErr);
      }

      process.exit(1);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });

  return serverInstance;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  persistAudioSessionBinding,
  registerSession,
  unregisterSession,
  getSessionById
};
