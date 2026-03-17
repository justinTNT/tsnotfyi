require('./utils/logTimestamps');
const express = require('express');
const session = require('express-session');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Worker } = require('worker_threads');
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
const DataAccess = require('./services/db');
const { SessionManager, buildRequestContext, extractRequestIp } = require('./services/session-manager');
const { SSEManager } = require('./services/sse-manager');

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

// ─── Service Initialization ─────────────────────────────────────────────────

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

// Phase 1: Data Access Layer
const db = new DataAccess(pool);

// Phase 2: Session Manager
const sessionManager = new SessionManager({
  config,
  db,
  radialSearch,
  fingerprintRegistry,
  // Defer mixer's internal explorer computation to the worker thread.
  // If the worker isn't ready yet, wait for it — audio plays fine in the dark.
  onExplorerNeeded: async (mixer, trackId, opts) => {
    const ready = await waitForExplorerWorker(45000);
    if (!ready) {
      serverLog.error('❌ Explorer worker did not become ready in 45s (mixer path)');
      return null; // fall through to main-thread as last resort
    }

    const resolution = mixer.explorerResolution || 'adaptive';
    const sessionContext = {
      seenArtists: Array.from(mixer.seenArtists || []),
      seenAlbums: Array.from(mixer.seenAlbums || []),
      sessionHistoryIds: (mixer.sessionHistory || []).map(e => e.identifier),
      currentTrackId: mixer.currentTrack?.identifier || null,
      noArtist: mixer.noArtist,
      noAlbum: mixer.noAlbum,
      failedTrackIds: Array.from(mixer.failedTrackAttempts || new Map())
        .filter(([_, count]) => count >= 3).map(([id]) => id)
    };
    const workerConfig = {
      explorerResolution: resolution,
      stackTotalCount: mixer.stackTotalCount || 0,
      stackRandomCount: mixer.stackRandomCount || 0,
      cachedRadius: mixer.adaptiveRadiusCache?.get(trackId)?.radius ?? null,
      dynamicRadiusHint: Number.isFinite(mixer.dynamicRadiusState?.currentRadius)
        ? mixer.dynamicRadiusState.currentRadius : null
    };

    const result = await requestExplorerFromWorker(trackId, sessionContext, workerConfig);

    if (result.radiusUsed != null) {
      mixer.adaptiveRadiusCache.set(trackId, {
        radius: result.radiusUsed,
        count: result.neighborhoodSize,
        updatedAt: Date.now()
      });
      mixer.currentAdaptiveRadius = {
        radius: result.radiusUsed,
        count: result.neighborhoodSize,
        cachedRadiusReused: false
      };
    }
    if (result.dynamicRadiusState && Number.isFinite(result.dynamicRadiusState.currentRadius)) {
      mixer.dynamicRadiusState.currentRadius = result.dynamicRadiusState.currentRadius;
    }
    if (result.explorerData) {
      mixer.explorerDataCache.set(trackId, resolution, result.explorerData);
      mixer.recordExplorerSummary(result.explorerData,
        result.explorerData.diagnostics?.radius || null,
        result.neighborhoodSize || 0);
    }
    return result.explorerData || null;
  }
});

// Phase 3: SSE Manager
const sseManager = new SSEManager({
  sessionManager,
  fingerprintRegistry,
  persistAudioSessionBinding
});

// Convenience accessors for backward compatibility
const audioSessions = sessionManager.audioSessions;
const ephemeralSessions = sessionManager.ephemeralSessions;

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

// ─── Explorer Worker Management ─────────────────────────────────────────────

let explorerWorker = null;
let explorerWorkerReady = false;
const pendingExplorerRequests = new Map(); // requestId -> { resolve, reject, timer }
let explorerRequestCounter = 0;

// Promise that resolves when the explorer worker reports ready.
// Callers can await this instead of falling back to main-thread explorer.
let _resolveWorkerReady = null;
const explorerWorkerReadyPromise = new Promise(resolve => { _resolveWorkerReady = resolve; });

/**
 * Wait for the explorer worker to become ready, up to timeoutMs.
 * Returns true if ready, false if timed out.
 */
async function waitForExplorerWorker(timeoutMs = 45000) {
  if (explorerWorkerReady) return true;
  const timeout = new Promise(resolve => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([explorerWorkerReadyPromise.then(() => true), timeout]);
}

function spawnExplorerWorker() {
  const workerPath = path.join(__dirname, 'explorer-worker.js');
  if (!fs.existsSync(workerPath)) {
    startupLog.warn('⚠️ explorer-worker.js not found — explorer will run on main thread');
    return;
  }

  explorerWorker = new Worker(workerPath);
  explorerWorkerReady = false;

  explorerWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'ready':
        explorerWorkerReady = true;
        if (_resolveWorkerReady) { _resolveWorkerReady(); _resolveWorkerReady = null; }
        startupLog.info(`✅ Explorer worker ready (KD-tree loaded in ${msg.loadTimeMs}ms)`);
        break;

      case 'explore_result': {
        const pending = pendingExplorerRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingExplorerRequests.delete(msg.requestId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg);
          }
        }
        break;
      }

      case 'error':
        startupLog.error('Explorer worker initialization error:', msg.error);
        break;
    }
  });

  explorerWorker.on('error', (err) => {
    startupLog.error('Explorer worker error:', err);
    explorerWorkerReady = false;
  });

  explorerWorker.on('exit', (code) => {
    startupLog.warn(`Explorer worker exited with code ${code}`);
    explorerWorkerReady = false;
    explorerWorker = null;
    // Reject all pending requests
    for (const [requestId, pending] of pendingExplorerRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Explorer worker exited'));
    }
    pendingExplorerRequests.clear();
  });

  // Tell worker to initialize (sequenced after main thread's KD-tree is ready)
  explorerWorker.postMessage({ type: 'init' });
}

/**
 * Send an explorer request to the worker thread.
 * Returns a Promise that resolves with the explorer result.
 */
function requestExplorerFromWorker(trackId, sessionContext, config, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!explorerWorker || !explorerWorkerReady) {
      reject(new Error('explorer_not_ready'));
      return;
    }

    const requestId = `req_${++explorerRequestCounter}_${Date.now()}`;
    const timer = setTimeout(() => {
      pendingExplorerRequests.delete(requestId);
      reject(new Error('Explorer request timed out'));
    }, timeoutMs);

    pendingExplorerRequests.set(requestId, { resolve, reject, timer });

    explorerWorker.postMessage({
      type: 'explore',
      requestId,
      trackId,
      sessionContext,
      config
    });
  });
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
  // Spawn explorer worker AFTER main KD-tree is loaded (sequenced, not parallel)
  spawnExplorerWorker();
  sessionManager.schedulePrimedSessions('startup');
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

// ─── Thin wrapper: Express req → SessionManager ─────────────────────────────

async function getSessionForRequest(req, { createIfMissing = true } = {}) {
  const persistBinding = (sessionId) => persistAudioSessionBinding(req, sessionId);
  const ctx = buildRequestContext(req, { persistBinding });
  return sessionManager.getSessionForContext(ctx, { createIfMissing });
}

// ─── Middleware ──────────────────────────────────────────────────────────────

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

// ─── Session Routes ─────────────────────────────────────────────────────────

// Create a new session on demand
app.post('/create-session', async (req, res) => {
  try {
    const session = await sessionManager.createSession();
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
      sessionManager.logSessionEvent('session_bootstrap_failed', {
        reason: 'session_unavailable',
        ip: extractRequestIp(req)
      }, { level: 'warn' });
      return res.status(503).json({ error: 'Session unavailable' });
    }

    const fingerprint = fingerprintRegistry.getFingerprintForSession(session.sessionId);
    sessionManager.logSessionEvent('session_bootstrap', {
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

// ─── Stream Route ───────────────────────────────────────────────────────────

app.get('/stream', async (req, res) => {
  try {
    const session = await getSessionForRequest(req, { createIfMissing: true });

    if (!session) {
      sessionManager.logSessionEvent('audio_stream_request_failed', {
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

    sessionManager.logSessionEvent('audio_stream_request', {
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
      sessionManager.lastHealthySessionByIp.set(clientIp, session.sessionId);
    }

    sessionManager.logSessionEvent('audio_client_connected', {
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

// Stream endpoint - backward compatibility
app.get('/stream/:sessionId', (req, res) => {
  serverLog.warn(`⚠️ Deprecated stream URL requested: /stream/${req.params.sessionId}`);
  res.status(410).json({ error: 'Session-specific stream URLs have been removed. Connect to /stream instead.' });
});

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

// ─── SSE Routes (Phase 3) ───────────────────────────────────────────────────

sseManager.registerRoutes(app);

// ─── Stack Duration ─────────────────────────────────────────────────────────

function calculateStackDuration(stack) {
  // TODO: Implement duration calculation
  // For now, estimate 3 minutes per track
  return stack.length * 180;
}

// ─── Route Setup ────────────────────────────────────────────────────────────

setupPlaylistRoutes(app, {
  db,
  createSession: (opts) => sessionManager.createSession(opts),
  getSessionById: (id) => sessionManager.getSessionById(id),
  registerSession: (id, s, opts) => sessionManager.registerSession(id, s, opts)
});

setupNamedSessionRoutes(app, {
  getSessionById: (id) => sessionManager.getSessionById(id),
  unregisterSession: (id) => sessionManager.unregisterSession(id),
  registerSession: (id, s, opts) => sessionManager.registerSession(id, s, opts),
  createSession: (opts) => sessionManager.createSession(opts),
  calculateStackDuration
});

setupApiRoutes(app, { db, radialSearch });

setupVaeRoutes(app, { vaeService, radialSearch });

// ─── MD5 Journey Routes ─────────────────────────────────────────────────────

app.get('/:md5', async (req, res, next) => {
  const md5 = req.params.md5;

  // Validate MD5 format (32-character hex string)
  if (!/^[a-f0-9]{32}$/.test(md5)) {
    return next();
  }

  const sessionId = md5;
  console.log(`🎯 Starting SSE-driven journey from track MD5: ${md5} (session: ${sessionId})`);

  try {
    let session = sessionManager.getSessionById(sessionId);
    if (!session) {
      console.log(`Creating new session for MD5: ${sessionId}`);
      session = await sessionManager.createSession({ sessionId, autoStart: false, ephemeral: true });
      session.mixer.initializeSession('anonymous', sessionId);
    }

    const track = session.mixer.radialSearch.kdTree.getTrack(md5);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    session.mixer.resetForJourney(track);

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

  if (!/^[a-f0-9]{32}$/.test(md51) || !/^[a-f0-9]{32}$/.test(md52)) {
    return next();
  }

  const sessionId = `${md51}_${md52}`;
  console.log(`🎯 SSE-driven contrived journey: ${md51} → ${md52} (session: ${sessionId})`);

  try {
    let session = sessionManager.getSessionById(sessionId);
    if (!session) {
      console.log(`Creating new contrived session: ${sessionId}`);
      session = await sessionManager.createSession({ sessionId, autoStart: false, ephemeral: true });
      const initialStack = [
        { identifier: md51, direction: null, scope: 'magnify' },
        { identifier: md52, direction: null, scope: 'magnify' }
      ];
      session.mixer.initializeSession('anonymous', sessionId, initialStack);
    }

    const track1 = session.mixer.radialSearch.kdTree.getTrack(md51);
    const track2 = session.mixer.radialSearch.kdTree.getTrack(md52);

    if (!track1) {
      return res.status(404).json({ error: `First track not found: ${md51}` });
    }
    if (!track2) {
      return res.status(404).json({ error: `Second track not found: ${md52}` });
    }

    session.mixer.resetForJourney(track1);
    session.mixer.selectNextTrack(md52, { origin: 'contrived-journey' }).catch(err => {
      console.warn('⚠️ Contrived journey next-track queue failed:', err?.message || err);
    });

    console.log(`🎯 Contrived journey seeded: ${track1.title} → ${track2.title}`);

    await persistAudioSessionBinding(req, session.sessionId);

    return res.redirect('/');
  } catch (error) {
    console.error('Contrived journey error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ─── Search Route ───────────────────────────────────────────────────────────

app.get('/search', async (req, res) => {
  const rawQuery = req.query.q;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const normalizedQuery = query.toLowerCase();
  const limit = parseInt(req.query.limit) || 50;

  if (!normalizedQuery || normalizedQuery.length < 2) {
    return res.json({ results: [], query: query, total: 0 });
  }

  console.log(`🔍 Fuzzy search: "${query}" (limit: ${limit})`);

  try {
    const rows = await db.trigramSearch(normalizedQuery, limit);

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


// Playlist management page
app.get('/playlists', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'playlists.html'));
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

// ─── Status & Current Track ─────────────────────────────────────────────────

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

app.get('/status/:sessionId', (req, res) => {
  console.log(`⚠️ Deprecated status URL requested: /status/${req.params.sessionId}`);
  res.status(410).json({ error: 'Session-specific status URLs have been removed. Query /status instead.' });
});

// ─── Radial Search Routes ───────────────────────────────────────────────────

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

app.post('/pca/explore', async (req, res) => {
  res.status(410).json({ error: 'This endpoint has been deprecated. Use POST /explorer instead.' });
});

// ─── Explorer Endpoint ──────────────────────────────────────────────────────

/**
 * Strip heavy/unused fields from explorer data before sending to client.
 */
function stripExplorerDataForClient(data, logLabel = 'explorer') {
  if (!data) return data;

  const beforeSize = JSON.stringify(data).length;

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

  const stripDirection = (dir, dirKey) => {
    if (!dir) return dir;
    if (!dir.direction) {
      serverLog.warn(`⚠️ stripDirection: missing .direction on ${dirKey} (domain=${dir.domain}, component=${dir.component}, polarity=${dir.polarity})`);
    }
    const stripped = {
      direction: dir.direction,
      domain: dir.domain,
      component: dir.component,
      polarity: dir.polarity,
      sampleTracks: (dir.sampleTracks || []).map(stripTrack),
      trackCount: dir.trackCount || dir.sampleTracks?.length || 0,
      hasOpposite: dir.hasOpposite,
      isOutlier: dir.isOutlier,
      diversityScore: dir.diversityScore
    };
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
        session = sessionManager.getSessionById(entry.sessionId) || null;
        fingerprintRegistry.touch(requestFingerprint.trim(), { metadataIp: req.ip });
      }
    }
    if (!session && sessionId) {
      session = sessionManager.getSessionById(sessionId) || null;
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

    const sourceTrack = radialSearch.kdTree?.getTrack(trackId);
    if (!sourceTrack) {
      serverLog.warn(`🎯 Track not found: ${trackId}`);
      return res.status(404).json({ error: 'Track not found' });
    }
    serverLog.info(`🎯 Exploring from track: ${sourceTrack.title} by ${sourceTrack.artist}`);

    let explorerData;
    const isSameTrack = session?.mixer?.currentTrack?.identifier === sourceTrack?.identifier;
    if (session?.mixer) {
      const mixer = session.mixer;
      const resolution = mixer.explorerResolution || 'adaptive';

      // Cache hit — reuse cached data (cheap)
      if (isSameTrack && mixer.explorerDataCache?.has(sourceTrack.identifier, resolution)) {
        serverLog.info(`🎯 Explorer cache hit (trackId=${trackId.substring(0,8)})`);
        explorerData = await mixer.getComprehensiveExplorerData({
          trackId: sourceTrack.identifier,
          forceFresh: false
        });
      } else {
        // Wait for worker if not ready — audio streams fine while we wait
        if (!explorerWorkerReady) {
          serverLog.info(`🎯 Waiting for explorer worker (trackId=${trackId.substring(0,8)})`);
          const ready = await waitForExplorerWorker(45000);
          if (!ready) {
            serverLog.error(`❌ Explorer worker did not become ready in 45s`);
            return res.status(503).json({ error: 'Explorer service unavailable' });
          }
        }

        serverLog.info(`🎯 Routing explorer to worker thread (trackId=${trackId.substring(0,8)})`);
        const sessionContext = {
          seenArtists: Array.from(mixer.seenArtists || []),
          seenAlbums: Array.from(mixer.seenAlbums || []),
          sessionHistoryIds: (mixer.sessionHistory || []).map(e => e.identifier),
          currentTrackId: mixer.currentTrack?.identifier || null,
          noArtist: mixer.noArtist,
          noAlbum: mixer.noAlbum,
          failedTrackIds: Array.from(mixer.failedTrackAttempts || new Map())
            .filter(([_, count]) => count >= 3).map(([id]) => id)
        };

        const workerConfig = {
          explorerResolution: resolution,
          stackTotalCount: mixer.stackTotalCount || 0,
          stackRandomCount: mixer.stackRandomCount || 0,
          cachedRadius: mixer.adaptiveRadiusCache?.get(sourceTrack.identifier)?.radius ?? null,
          dynamicRadiusHint: Number.isFinite(mixer.dynamicRadiusState?.currentRadius)
            ? mixer.dynamicRadiusState.currentRadius : null
        };

        const result = await requestExplorerFromWorker(sourceTrack.identifier, sessionContext, workerConfig);
        explorerData = result.explorerData;

        if (result.radiusUsed != null) {
          mixer.adaptiveRadiusCache.set(sourceTrack.identifier, {
            radius: result.radiusUsed,
            count: result.neighborhoodSize,
            updatedAt: Date.now()
          });
          mixer.currentAdaptiveRadius = {
            radius: result.radiusUsed,
            count: result.neighborhoodSize,
            cachedRadiusReused: false
          };
        }
        if (result.dynamicRadiusState && Number.isFinite(result.dynamicRadiusState.currentRadius)) {
          mixer.dynamicRadiusState.currentRadius = result.dynamicRadiusState.currentRadius;
        }
        if (explorerData) {
          mixer.explorerDataCache.set(sourceTrack.identifier, resolution, explorerData);
          mixer.recordExplorerSummary(explorerData,
            explorerData.diagnostics?.radius || null,
            result.neighborhoodSize || 0);
        }
        serverLog.info(`🎯 Worker explorer complete (${result.computeTimeMs}ms)`);
      }
    } else {
      serverLog.info(`🎯 No session available, using standalone radial search for explorer data`);
      const rawExplorer = await radialSearch.exploreFromTrack(trackId, { usePCA: true });
      const rawOptionCount = Object.keys(rawExplorer.directionalOptions || {}).length;
      serverLog.info(`🎯 Standalone: ${rawOptionCount} directional options (fallback path)`);
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

      const prioritized = [];
      const deprioritized = [];

      for (const sample of direction.sampleTracks) {
        const track = sample.track || sample;
        const trackIdentifier = track.identifier || track.trackMd5;

        if (playlistTrackSet.has(trackIdentifier)) {
          continue;
        }

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

    const filteredDirSummary = Object.entries(filteredDirections).map(([k, d]) => ({
      key: k,
      trackCount: d.sampleTracks?.length || 0,
      diversityScore: d.diversityScore
    }));
    serverLog.info(`🎯 Filtered directions: ${JSON.stringify(filteredDirSummary)}`);

    // Pick recommended next track from filtered directions
    let nextTrack = null;
    if (explorerData.nextTrack) {
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

    // Reconcile explorer recommendation with mixer state
    const currentTrackId = session?.mixer?.currentTrack?.identifier;
    const preparedNextId = session?.mixer?.nextTrack?.identifier;
    const explorerNextId = nextTrack?.track?.identifier;
    const isPreparationInProgress = session?.mixer?._preparationInProgress || session?.mixer?.pendingPreparationPromise;

    if (session?.mixer && explorerNextId && trackId === currentTrackId) {
      if (preparedNextId && preparedNextId !== explorerNextId && preparedNextId !== currentTrackId) {
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
        serverLog.warn(`📌 Mixer nextTrack ${preparedNextId?.substring(0,8)} === currentTrack — ignoring stale mixer state`);
      } else if (preparedNextId && preparedNextId === explorerNextId) {
        serverLog.info(`📌 Explorer recommendation ${explorerNextId?.substring(0,8)} matches prepared next — not storing (would cause repeat)`);
      } else {
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

// ─── Session Control Routes ─────────────────────────────────────────────────

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

// ─── Next Track Endpoint ────────────────────────────────────────────────────

app.post('/next-track', async (req, res) => {
  const {
    trackMd5,
    direction,
    source = 'user',
    origin = null,
    explorerSignature = null,
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
    session = sessionManager.getSessionById(entry.sessionId) || null;
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

      await session.mixer.selectNextTrack(trackMd5, { direction, origin: normalizedOrigin });
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

    const duration = session.mixer.getAdjustedTrackDuration() * 1000;
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
    const session = await sessionManager.createSession({ autoStart: true, ephemeral: true });
    const mixer = session.mixer;

    const publicSessionId = mixer.currentTrack?.identifier || session.sessionId;
    if (publicSessionId !== session.sessionId) {
      sessionManager.unregisterSession(session.sessionId);
      session.sessionId = publicSessionId;
      session.mixer.sessionId = publicSessionId;
      sessionManager.registerSession(publicSessionId, session, { ephemeral: true });
      sessionManager.attachEphemeralCleanup(publicSessionId, session);
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

// ─── Health & Monitoring ────────────────────────────────────────────────────

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
  const session = sessionManager.getSessionById(sessionId);
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

// ─── Server Startup ─────────────────────────────────────────────────────────

let serverInstance = null;
let cleanupTimer = null;
let hasRegisteredSigintHandler = false;

function startServer() {
  if (serverInstance) {
    return serverInstance;
  }

  checkSingleton();

  cleanupTimer = setInterval(() => {
    sessionManager.cleanupInactiveSessions();
  }, 60 * 1000);

  if (!hasRegisteredSigintHandler) {
    process.on('SIGINT', () => {
      console.log('Shutting down gracefully...');

      // Phase 2: delegate to session manager
      sessionManager.close();

      radialSearch.close();

      // Terminate explorer worker
      if (explorerWorker) {
        explorerWorker.terminate().catch(() => {});
        explorerWorker = null;
        explorerWorkerReady = false;
      }

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
  registerSession: (id, s, opts) => sessionManager.registerSession(id, s, opts),
  unregisterSession: (id) => sessionManager.unregisterSession(id),
  getSessionById: (id) => sessionManager.getSessionById(id)
};
