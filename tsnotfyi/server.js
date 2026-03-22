require('./utils/logTimestamps');
require('./server-logger').setServerName('web');
const express = require('express');
const session = require('express-session');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { Pool } = require('pg');
const fingerprintRegistry = require('./fingerprint-registry');
const serverLogger = require('./server-logger');
const internalMetrics = require('./metrics/internalMetrics');
const { ExplorerResponse, validateOrWarn } = require('./contracts-zod');
const { setupPlaylistRoutes } = require('./routes/playlist');
const { setupNamedSessionRoutes, isValidMD5, RESERVED_SESSION_PREFIXES } = require('./routes/named-session');
const { setupApiRoutes } = require('./routes/api');
const DataAccess = require('./services/db');
const { SessionManager, buildRequestContext, extractRequestIp } = require('./services/session-manager');
const { SSEManager } = require('./services/sse-manager');
const AudioClient = require('./services/audio-client');

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

const ApiClient = require('./services/api-client');
const apiClient = new ApiClient({ url: config.api?.url || 'http://localhost:3003' });
const audioClient = new AudioClient({ url: config.audioServer?.url || 'http://localhost:3002' });

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

// Phase 2: Session Manager (delegates mixer operations to Audio server)
const sessionManager = new SessionManager({
  config,
  db,
  audioClient,
  fingerprintRegistry
});

// Phase 3: SSE Manager
const sseManager = new SSEManager({
  sessionManager,
  fingerprintRegistry,
  persistAudioSessionBinding,
  audioClient,
  audioServerUrl: config.audioServer?.url || 'http://localhost:3002'
});

// Convenience accessors for backward compatibility
const audioSessions = sessionManager.audioSessions;
const ephemeralSessions = sessionManager.ephemeralSessions;

async function initializeServices() {
  if (process.env.SKIP_SERVICE_INIT) {
    startupLog.info('Skipping service initialization (SKIP_SERVICE_INIT set)');
    return;
  }

  // Wait for API server (KD-tree, explorer, search)
  startupLog.info(`🌐 API server: ${config.api?.url || 'http://localhost:3003'}`);
  const apiReady = await apiClient.waitForReady(60000);
  if (!apiReady) {
    startupLog.error('❌ API server did not become ready in 60s');
    process.exit(1);
  }
  startupLog.info('✅ API server is ready');

  // Wait for Audio server (mixer, streaming)
  startupLog.info(`🎵 Audio server: ${config.audioServer?.url || 'http://localhost:3002'}`);
  const audioReady = await audioClient.waitForReady(30000);
  if (!audioReady) {
    startupLog.error('❌ Audio server did not become ready in 30s');
    process.exit(1);
  }
  startupLog.info('✅ Audio server is ready');
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

    const audioServerUrl = config.audioServer?.url || 'http://localhost:3002';
    let mixerReady = true;
    try {
      const state = await audioClient.getMixerState(session.sessionId);
      mixerReady = state.isActive || state.audioClients > 0;
    } catch (e) { mixerReady = false; }

    res.json({
      sessionId: session.sessionId,
      fingerprint: fingerprint || null,
      mixerReady,
      createdAt: session.created ? session.created.toISOString() : null,
      audioStreamUrl: `${audioServerUrl}/stream?sessionId=${session.sessionId}`,
      audioEventsUrl: `${audioServerUrl}/events?sessionId=${session.sessionId}`
    });
  } catch (error) {
    sessionLog.error('Failed to bootstrap session:', error);
    res.status(500).json({ error: 'Failed to bootstrap session' });
  }
});

// ─── Stream Route ───────────────────────────────────────────────────────────
// Proxies PCM stream from Audio server. Client connects here on same origin,
// avoiding CORS. Future: client connects directly to Audio server on LAN.

app.get('/stream', async (req, res) => {
  try {
    const session = await getSessionForRequest(req, { createIfMissing: true });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    await sessionManager.ensureAudioSession(session);
    const audioServerUrl = config.audioServer?.url || 'http://localhost:3002';
    const audioStreamUrl = `${audioServerUrl}/stream?sessionId=${session.sessionId}`;

    // Proxy the PCM stream from Audio server
    const controller = new AbortController();
    const audioRes = await fetch(audioStreamUrl, { signal: controller.signal });

    if (!audioRes.ok) {
      return res.status(audioRes.status).json({ error: 'Audio stream unavailable' });
    }

    // Forward headers
    res.writeHead(200, {
      'Content-Type': audioRes.headers.get('content-type') || 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked'
    });

    const reader = audioRes.body.getReader();
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.writableEnded) res.write(value);
        }
      } catch (e) {
        // Stream ended
      }
      if (!res.writableEnded) res.end();
    };
    pump();

    req.on('close', () => {
      controller.abort();
    });
  } catch (error) {
    console.error('Stream proxy error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to proxy stream' });
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
  registerSession: (id, s, opts) => sessionManager.registerSession(id, s, opts),
  audioClient
});

setupNamedSessionRoutes(app, {
  getSessionById: (id) => sessionManager.getSessionById(id),
  unregisterSession: (id) => sessionManager.unregisterSession(id),
  registerSession: (id, s, opts) => sessionManager.registerSession(id, s, opts),
  createSession: (opts) => sessionManager.createSession(opts),
  calculateStackDuration,
  db,
  audioClient
});

setupApiRoutes(app, { db, apiClient });

// VAE routes are served by the API server

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
      await audioClient.initializeSession(sessionId, 'anonymous', sessionId);
    }

    const track = await apiClient.getTrack(md5);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    await audioClient.resetForJourney(sessionId, track);

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
      await audioClient.initializeSession(sessionId, 'anonymous', sessionId, initialStack);
    }

    const track1 = await apiClient.getTrack(md51);
    const track2 = await apiClient.getTrack(md52);

    if (!track1) {
      return res.status(404).json({ error: `First track not found: ${md51}` });
    }
    if (!track2) {
      return res.status(404).json({ error: `Second track not found: ${md52}` });
    }

    await audioClient.resetForJourney(sessionId, track1);
    audioClient.selectNextTrack(sessionId, md52, { origin: 'contrived-journey' }).catch(err => {
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
    // Look up from API server (KD-tree)
    let track = await apiClient.getTrack(identifier);

    // Fall back: try to hydrate from any active Audio server session
    if (!track) {
      for (const session of sessionManager.allSessions()) {
        try {
          const result = await audioClient.hydrateTrack(session.sessionId, identifier);
          if (result?.track?.identifier === identifier) {
            track = result.track;
            break;
          }
        } catch (e) { /* ignore */ }
      }
    }

    if (!track) {
      return res.status(404).json({ error: 'track not found' });
    }

    return res.json({ track });
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
  if (!session) return res.status(404).json({ error: 'Session not found' });

  try {
    const result = await audioClient.getStats(session.sessionId);
    res.json({
      ...result.stats,
      created: session.created,
      lastAccess: session.lastAccess
    });
  } catch (e) {
    res.json({ created: session.created, lastAccess: session.lastAccess, error: 'Audio server unavailable' });
  }
});

app.get('/current-track', async (req, res) => {
  const session = await getSessionForRequest(req, { createIfMissing: false });
  if (!session) return res.status(404).json({ error: 'No active session' });

  try {
    const result = await audioClient.getStats(session.sessionId);
    if (!result?.heartbeat?.currentTrack) return res.status(204).send();
    res.json(result.heartbeat);
  } catch (e) {
    res.status(503).json({ error: 'Audio server unavailable' });
  }
});

app.get('/status/:sessionId', (req, res) => {
  console.log(`⚠️ Deprecated status URL requested: /status/${req.params.sessionId}`);
  res.status(410).json({ error: 'Session-specific status URLs have been removed. Query /status instead.' });
});

// Search/PCA/radial-search endpoints are served by the API server (port 3003)
// Proxy them for backward compatibility with client JS

app.post('/radial-search', async (req, res) => {
  try { res.json(await apiClient.radialSearch(req.body.trackId, req.body.config)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/directional-search', async (req, res) => {
  try { res.json(await apiClient.directionalSearch(req.body.trackId, req.body.direction, req.body.config)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/radial-search/stats', async (req, res) => {
  try { res.json(await apiClient.getStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/pca/directions', async (req, res) => {
  try { res.json(await apiClient.getPCADirections()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/pca/resolutions', async (req, res) => {
  try { res.json(await apiClient.getResolutionSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/pca/directional-search', async (req, res) => {
  try {
    const { trackId, pcaDomain, pcaComponent, direction, config = {} } = req.body;
    res.json(await apiClient.pcaDirectionalSearch(trackId, pcaDomain, pcaComponent || 'pc1', direction, config));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      try {
        const trackData = await apiClient.getTrack(pid);
        if (trackData) {
          if (trackData.artist) playlistArtists.add(trackData.artist.toLowerCase());
          if (trackData.album) playlistAlbums.add(trackData.album.toLowerCase());
        }
      } catch (e) { /* ignore */ }
    }

    const sourceTrack = await apiClient.getTrack(trackId);
    if (!sourceTrack) {
      serverLog.warn(`🎯 Track not found: ${trackId}`);
      return res.status(404).json({ error: 'Track not found' });
    }
    serverLog.info(`🎯 Exploring from track: ${sourceTrack.title} by ${sourceTrack.artist}`);

    let explorerData;
    if (session) {
      // Try cache on Audio server first, then API server
      serverLog.info(`🎯 Routing explorer via Audio server (trackId=${trackId.substring(0,8)})`);
      try {
        const cachedResult = await audioClient.getExplorerData(session.sessionId, { trackId: sourceTrack.identifier, forceFresh: false });
        if (cachedResult?.explorerData) {
          explorerData = cachedResult.explorerData;
          serverLog.info(`🎯 Explorer cache hit on Audio server`);
        }
      } catch (e) { /* cache miss, proceed to API */ }

      if (!explorerData) {
        // Get session state from Audio server for context
        let sessionState;
        try {
          sessionState = await audioClient.getFullState(session.sessionId);
        } catch (e) {
          sessionState = {};
        }

        const sessionContext = {
          seenArtists: sessionState.seenArtists || [],
          seenAlbums: sessionState.seenAlbums || [],
          sessionHistoryIds: (sessionState.sessionHistory || []).map(e => e.identifier),
          currentTrackId: sessionState.currentTrack?.identifier || null,
          noArtist: sessionState.noArtist,
          noAlbum: sessionState.noAlbum,
          failedTrackIds: (sessionState.failedTrackAttempts || [])
            .filter(([_, count]) => count >= 3).map(([id]) => id)
        };

        const workerConfig = {
          explorerResolution: sessionState.explorerResolution || 'adaptive',
          stackTotalCount: sessionState.stackTotalCount || 0,
          stackRandomCount: sessionState.stackRandomCount || 0,
          cachedRadius: sessionState.adaptiveRadiusCache?.[sourceTrack.identifier]?.radius ?? null,
          dynamicRadiusHint: Number.isFinite(sessionState.dynamicRadiusState?.currentRadius)
            ? sessionState.dynamicRadiusState.currentRadius : null
        };

        const result = await apiClient.explore(sourceTrack.identifier, sessionContext, workerConfig);
        explorerData = result.explorerData;
        serverLog.info(`🎯 API explorer complete (${result.computeTimeMs}ms)`);
      }
    } else {
      serverLog.info(`🎯 No session available, routing to API server (trackId=${trackId.substring(0,8)})`);
      const result = await apiClient.explore(trackId, {}, {});
      explorerData = result.explorerData;
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

    // Reconcile explorer recommendation with mixer state on Audio server
    const explorerNextId = nextTrack?.track?.identifier;
    if (session && explorerNextId) {
      try {
        const mixerState = await audioClient.getFullState(session.sessionId);
        const currentTrackId = mixerState?.currentTrack?.identifier;
        const preparedNextId = mixerState?.nextTrack?.identifier;

        if (preparedNextId && preparedNextId !== explorerNextId && preparedNextId !== currentTrackId && trackId === currentTrackId) {
          const preparedTrack = mixerState.nextTrack;
          serverLog.info(`📌 Explorer recommends ${explorerNextId?.substring(0,8)} but mixer has ${preparedNextId?.substring(0,8)} prepared — overriding response`);
          nextTrack = {
            directionKey: preparedTrack?.directionKey || preparedTrack?.transitionDirectionKey || null,
            direction: preparedTrack?.direction || preparedTrack?.transitionDirection || null,
            track: {
              identifier: preparedTrack.identifier,
              title: preparedTrack.title,
              artist: preparedTrack.artist,
              album: preparedTrack.album,
              albumCover: preparedTrack.albumCover,
              duration: preparedTrack.duration || preparedTrack.length
            }
          };
        } else if (!preparedNextId && trackId === currentTrackId) {
          // Store recommendation and fill empty next slot
          await audioClient.setRecommendation(session.sessionId, {
            trackId: explorerNextId,
            direction: nextTrack.direction,
            directionKey: nextTrack.directionKey,
            track: nextTrack.track
          });
          audioClient.prepareNextCrossfade(session.sessionId, {
            forceRefresh: false,
            reason: 'explorer-fill',
            overrideTrackId: explorerNextId,
            overrideDirection: nextTrack.direction
          }).catch(err => {
            serverLog.warn(`⚠️ Explorer-fill preparation failed: ${err?.message || err}`);
          });
          serverLog.info(`📌 Stored recommendation and filling: ${explorerNextId?.substring(0,8)}`);
        } else if (trackId === currentTrackId && preparedNextId !== explorerNextId) {
          await audioClient.setRecommendation(session.sessionId, {
            trackId: explorerNextId,
            direction: nextTrack.direction,
            directionKey: nextTrack.directionKey,
            track: nextTrack.track
          });
          serverLog.info(`📌 Stored explorer recommendation: ${explorerNextId?.substring(0,8)}`);
        }
      } catch (e) {
        serverLog.warn(`📌 Failed to reconcile with Audio server: ${e.message}`);
      }
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
    await audioClient.resetDrift(session.sessionId);
    res.json({ message: 'Drift reset successfully' });
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
    console.log(`🎛️ User triggered: ${direction}`);
    await audioClient.triggerDirectionalFlow(session.sessionId, direction);
    res.json({ message: `Flowing ${direction}`, direction });
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

    await audioClient.forceNext(session.sessionId);
    res.json({ message: 'Track change forced' });
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

    const normalizedMode = mode === 'auto' ? 'adaptive' : mode;
    await audioClient.setResolution(session.sessionId, normalizedMode);

    const deprecated = ['microscope', 'magnifying', 'binoculars'].includes(mode);
    const modeEmoji = { 'adaptive': '🧭', 'auto': '🧭', 'microscope': '🔬', 'magnifying': '🔍', 'binoculars': '🔭' };

    res.json({
      message: deprecated
        ? `${modeEmoji[normalizedMode] || ''} Adaptive explorer tuning is now automatic`
        : `${modeEmoji[normalizedMode] || ''} Adaptive explorer tuning confirmed`,
      mode: 'adaptive',
      requestedMode: mode,
      sessionId: session.sessionId,
      resolution: normalizedMode,
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
    fingerprint: requestFingerprint,
    clientBufferSecs
  } = req.body;
  const normalizedSource = typeof source === 'string' ? source.toLowerCase() : 'user';
  const normalizedOrigin = typeof origin === 'string' ? origin.toLowerCase() : null;

  if (!trackMd5) {
    return res.status(400).json({ error: 'Track MD5 is required' });
  }

  let session = null;

  if (typeof requestFingerprint === 'string' && requestFingerprint.trim()) {
    const entry = fingerprintRegistry.lookup(requestFingerprint.trim());
    if (entry) {
      session = sessionManager.getSessionById(entry.sessionId) || null;
      if (session) {
        fingerprintRegistry.touch(requestFingerprint.trim(), { metadataIp: req.ip });
      }
    }
    // Fall back to cookie/session resolution if fingerprint lookup failed
    if (!session) {
      serverLog.warn(`⚠️ /next-track fingerprint lookup failed, falling back to session resolution`);
      session = await getSessionForRequest(req, { createIfMissing: false });
    }
  } else {
    session = await getSessionForRequest(req, { createIfMissing: false });
  }

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Store client buffer depth
  if (Number.isFinite(clientBufferSecs) && clientBufferSecs >= 0) {
    session.clientBufferSecs = clientBufferSecs;
    audioClient.setClientBuffer(session.sessionId, clientBufferSecs).catch(() => {});
  }

  try {
    const cleanMd5 = typeof trackMd5 === 'string' ? trackMd5 : null;
    const advertisedDirection = typeof direction === 'string' ? direction : null;
    const isDeckSelection = normalizedSource === 'user' && normalizedOrigin === 'deck';

    // For deck selections, try to find track in explorer data and prepare
    if (isDeckSelection) {
      try {
        const state = await audioClient.getFullState(session.sessionId);
        const lastExplorer = state.lastExplorerSnapshotPayload?.explorer || null;
        const deckMatch = findTrackInExplorerSnapshot(lastExplorer, cleanMd5);

        if (deckMatch) {
          const deckDirection = advertisedDirection || deckMatch.directionKey || null;
          await audioClient.prepareNextCrossfade(session.sessionId, {
            forceRefresh: true,
            reason: 'deck-selection',
            overrideTrackId: cleanMd5,
            overrideDirection: deckDirection
          });
          await audioClient.clearPendingSelection(session.sessionId);
          await audioClient.broadcastSelection(session.sessionId, 'selection_ack', {
            status: 'promoted', trackId: cleanMd5, direction: deckDirection, origin: 'deck'
          });

          const updatedState = await audioClient.getFullState(session.sessionId);
          console.log(`📤 /next-track deck promotion: ${cleanMd5?.substring(0,8) || 'none'} via ${deckDirection || 'unknown'}`);

          return res.json({
            status: 'deck_ack',
            origin: 'deck',
            sessionId: session.sessionId,
            fingerprint: fingerprintRegistry.getFingerprintForSession(session.sessionId),
            currentTrack: updatedState.currentTrack?.identifier || null,
            nextTrack: updatedState.nextTrack?.identifier || null,
            pendingTrack: updatedState.pendingCurrentTrack?.identifier || null,
            trackId: cleanMd5,
            direction: deckDirection
          });
        }
      } catch (e) {
        console.warn(`⚠️ Deck selection via Audio server failed: ${e.message}`);
      }
    }

    if (normalizedSource === 'user') {
      const originLabel = normalizedOrigin ? `/${normalizedOrigin}` : '';
      console.log(`🎯 User selected specific track${originLabel}: ${trackMd5} (direction: ${direction})`);
      await audioClient.selectNextTrack(session.sessionId, trackMd5, { direction, origin: normalizedOrigin });
    } else {
      console.log(`💓 Heartbeat sync request received (clientNext=${cleanMd5?.substring(0,8) || 'none'})`);
    }

    // Get final state from Audio server
    const finalState = await audioClient.getFullState(session.sessionId);

    const responsePayload = {
      status: normalizedSource === 'user' ? 'locked' : 'ok',
      origin: normalizedOrigin || null,
      sessionId: session.sessionId,
      fingerprint: fingerprintRegistry.getFingerprintForSession(session.sessionId),
      currentTrack: finalState.currentTrack?.identifier || null,
      nextTrack: finalState.nextTrack?.identifier || null,
      pendingTrack: finalState.pendingCurrentTrack?.identifier || null
    };

    if (normalizedSource === 'user') {
      responsePayload.trackId = cleanMd5 || null;
      responsePayload.direction = advertisedDirection || null;
      responsePayload.origin = normalizedOrigin || responsePayload.origin;
    }

    res.json(responsePayload);
  } catch (error) {
    console.error('Next track selection error:', error);
    if (normalizedSource === 'user') {
      audioClient.broadcastSelection(session.sessionId, 'selection_failed', {
        status: 'failed', trackId: trackMd5, reason: error?.message || 'request_failed'
      }).catch(() => {});
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

    // Get current track from Audio server
    let currentTrack = null;
    try {
      const state = await audioClient.getMixerState(session.sessionId);
      currentTrack = state?.currentTrack || null;

      // Rename session to track identifier if available
      const publicSessionId = currentTrack?.identifier || session.sessionId;
      if (publicSessionId !== session.sessionId) {
        await audioClient.updateMetadata(session.sessionId, { sessionId: publicSessionId });
        sessionManager.unregisterSession(session.sessionId);
        session.sessionId = publicSessionId;
        sessionManager.registerSession(publicSessionId, session, { ephemeral: true });
      }
    } catch (e) { /* ignore */ }

    await persistAudioSessionBinding(req, session.sessionId);

    const audioServerUrl = config.audioServer?.url || 'http://localhost:3002';
    res.json({
      sessionId: session.sessionId,
      streamUrl: `${audioServerUrl}/stream?sessionId=${session.sessionId}`,
      eventsUrl: `${audioServerUrl}/events?sessionId=${session.sessionId}`,
      webUrl: '/',
      currentTrack
    });
  } catch (error) {
    console.error('Failed to create random journey session:', error);
    res.status(500).json({ error: 'Failed to create random journey' });
  }
});

// ─── Internal Callbacks from Audio Server ────────────────────────────────────

// Audio server calls this when a track reaches halfway (for play count recording)
app.post('/internal/track-completed', async (req, res) => {
  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'identifier required' });
  try {
    await db.recordCompletion(identifier);
    sessionLog.info(`🎵 Halfway reached for ${identifier.substring(0, 8)} — recorded completion`);
    res.json({ ok: true });
  } catch (err) {
    sessionLog.error(`Failed to record halfway completion for ${identifier}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Audio server calls this when a named session goes idle (for auto-save)
app.post('/internal/session-idle/:sessionName', async (req, res) => {
  const { sessionName } = req.params;
  try {
    const state = await audioClient.getStackState(sessionName);
    await db.saveNamedSession(sessionName, state);
    console.log(`💾 Auto-saved named session on disconnect: ${sessionName}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`Failed to auto-save session ${sessionName}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health & Monitoring ────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  let audioHealth = null;
  let apiHealth = null;
  try { audioHealth = await audioClient.health(); } catch (e) { /* ignore */ }
  try { apiHealth = await apiClient.health(); } catch (e) { /* ignore */ }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    webSessions: audioSessions.size,
    audioServer: audioHealth,
    apiServer: apiHealth
  });
});

const { buildNowPlayingSessions } = require('./routes/nowPlaying');

app.get('/sessions/now-playing', async (req, res) => {
  const sessions = await buildNowPlayingSessions(audioSessions, ephemeralSessions, { now: Date.now(), audioClient });
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    sessions
  });
});

app.get('/internal/metrics', async (req, res) => {
  let apiStats = null;
  try { apiStats = await apiClient.getStats(); } catch (e) { /* ignore */ }

  const snapshot = internalMetrics.getMetricsSnapshot({
    sessions: {
      active: audioSessions.size,
      ephemeral: ephemeralSessions.size
    },
    apiServer: apiStats
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

app.get('/internal/sessions/:sessionId/events', async (req, res) => {
  const sessionId = req.params.sessionId;
  try {
    const state = await audioClient.getFullState(sessionId);
    const limit = Number(req.query.limit);
    const events = Array.isArray(state.sessionEvents) ? state.sessionEvents : [];
    const payload = Number.isFinite(limit) && limit > 0 ? events.slice(-limit) : events;
    res.json({ sessionId, timestamp: Date.now(), count: payload.length, events: payload });
  } catch (e) {
    res.status(404).json({ error: 'Session not found' });
  }
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
