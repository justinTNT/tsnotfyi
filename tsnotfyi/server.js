const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const DriftAudioMixer = require('./drift-audio-mixer');
const RadialSearchService = require('./radial-search');
const sqlite3 = require('sqlite3').verbose();
const fingerprintRegistry = require('./fingerprint-registry');

// Load configuration
const configPath = path.join(__dirname, 'tsnotfyi-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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
        console.error('⚠️ Failed to persist express session binding:', err);
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
        console.error(`❌ SINGLETON VIOLATION: Server already running with PID ${existingPid}`);
        console.error(`❌ Kill the existing server first: kill ${existingPid}`);
        process.exit(1);
      } catch (err) {
        // Process doesn't exist, remove stale PID file
        console.log(`🧹 Removing stale PID file for non-existent process ${existingPid}`);
        fs.unlinkSync(pidFile);
      }
    } catch (err) {
      console.log(`🧹 Removing corrupted PID file`);
      fs.unlinkSync(pidFile);
    }
  }

  // Write our PID
  fs.writeFileSync(pidFile, process.pid.toString());
  console.log(`🔒 Server singleton locked with PID ${process.pid}`);

  // Clean up PID file on exit
  process.on('exit', () => {
    try {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
        console.log(`🔓 Released singleton lock`);
      }
    } catch (err) {
      console.error('Error removing PID file:', err);
    }
  });
}

// Check singleton before starting
checkSingleton();

const audioSessions = new Map(); // Keep for backward compatibility
const ephemeralSessions = new Map(); // One-off MD5 journey sessions
const lastHealthySessionByIp = new Map();

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
    console.warn(message);
  } else if (level === 'error') {
    console.error(message);
  } else {
    console.log(message);
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

function attachEphemeralCleanup(sessionId, session) {
  if (!session || !session.mixer) {
    return;
  }

  session.mixer.onIdle = () => {
    console.log(`🧹 Cleaning up ephemeral session: ${sessionId}`);
    unregisterSession(sessionId);
    session.mixer.onIdle = null;
  };
}

// Initialize radial search service
const radialSearch = new RadialSearchService();

// Initialize database connection
const dbPath = config.database.path.replace('~', process.env.HOME);
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('📊 Connected to music database');
  }
});

async function initializeServices() {
  try {
    await radialSearch.initialize();
    console.log('✅ Radial search service initialized');
  } catch (err) {
    console.error('Failed to initialize services:', err);
  }
}

async function createSession(options = {}) {
  const {
    sessionId = `session_${crypto.randomBytes(4).toString('hex')}`,
    autoStart = true,
    register = true,
    ephemeral = false
  } = options;

  console.log(`🎯 Creating session: ${sessionId}`);

  const mixer = new DriftAudioMixer(sessionId, radialSearch);
  mixer.pendingClientBootstrap = true;

  if (autoStart) {
    try {
      await mixer.startDriftPlayback();
      console.log(`✅ Session ${sessionId} started with initial track`);
    } catch (error) {
      console.error(`❌ Failed to start session ${sessionId}:`, error);
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

initializeServices();

// Prune stale fingerprints every minute (5 minute TTL)
setInterval(() => {
  try {
    fingerprintRegistry.pruneStale(60 * 60 * 1000); // prune entries older than 1 hour
  } catch (err) {
    console.warn('⚠️ Fingerprint prune failed:', err?.message || err);
  }
}, 10 * 60 * 1000);

// Serve static files and middleware
app.use(express.json());

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

app.use(express.static('public'));
app.use( '/images', express.static('images') );
app.use( '/Volumes', express.static('/Volumes', { fallthrough: false }) );

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
    console.error('Failed to create session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Bootstrap a stream and return fingerprint and stream URL
async function getSessionForRequest(req, { createIfMissing = true } = {}) {
  const queryIdRaw = req.query && typeof req.query.session === 'string' ? req.query.session.trim() : null;
  const queryId = queryIdRaw || null;
  const cookieId = req.session?.audioSessionId || null;
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
      session = await createSession();
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

  const session = await createSession();
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
    const session = await getSessionForRequest(req);

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
  console.log(`⚠️ Deprecated stream URL requested: /stream/${req.params.sessionId}`);
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

    console.log(`${isFollowMode ? '👁️' : '🎮'} Legacy session request for ${requestedId}; redirecting to '/'`);
  } catch (error) {
    console.error('Failed to resolve session for legacy /session/:sessionId route:', error);
  }

  res.redirect(302, isFollowMode ? '/?mode=follow' : '/');
});


// Simplified events endpoint - resolves session from request context
app.get('/events', async (req, res) => {
  console.log('📡 SSE connection attempt');

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

    let session = findOrphanSession(clientIp);
    let resolution = session ? 'orphan' : null;

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
      session = await getSessionForRequest(req);
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
      console.log('📡 Sending heartbeat and explorer snapshot to new SSE client');
      await session.mixer.broadcastHeartbeat('sse-connected', { force: true });
      session.mixer.broadcastExplorerSnapshot(true, 'sse-connected').catch(err => {
        console.error('📡 Failed to broadcast explorer snapshot on connect:', err);
      });
    } else {
      console.log('📡 No valid current track to broadcast, skipping initial snapshot');
    }

    req.on('close', () => {
      if (session && session.mixer.removeEventClient) {
        session.mixer.removeEventClient(res);
      }
    });

  } catch (error) {
    console.error('📡 SSE connection error:', error);
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
  console.log(`⚠️ Deprecated SSE URL requested: /events/${req.params.sessionId}`);
  res.status(410).json({ error: 'Session-specific SSE URLs have been removed. Connect to /events instead.' });
});

// SSE refresh endpoint - triggers server to rebroadcast current state via SSE (pull/monadic)
app.post('/refresh-sse', async (req, res) => {
  const requestFingerprint = typeof req.body.fingerprint === 'string' ? req.body.fingerprint.trim() : null;
  const sessionIdFromBody = req.body.sessionId || req.session?.audioSessionId || null;

  let session = null;
  if (requestFingerprint) {
    const entry = fingerprintRegistry.lookup(requestFingerprint);
    if (entry) {
      session = getSessionById(entry.sessionId) || null;
      if (session) {
        fingerprintRegistry.touch(requestFingerprint, { metadataIp: req.ip });
      }
    }
    if (!session) {
      return res.status(404).json({ error: 'Fingerprint not found' });
    }
  } else if (sessionIdFromBody) {
    session = getSessionById(sessionIdFromBody);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
  } else {
    return res.status(400).json({ error: 'Fingerprint or session ID is required' });
  }

  const sessionId = session.sessionId;
  console.log(`🔄 SSE refresh request for session ${sessionId}${requestFingerprint ? ` (fingerprint=${requestFingerprint})` : ''}`);

  try {
    const summary = session.mixer.getStreamSummary ? session.mixer.getStreamSummary() : null;
    const isStreaming = session.mixer.isStreamAlive ? session.mixer.isStreamAlive() :
      Boolean(session.mixer.audioMixer?.engine?.isStreaming || (session.mixer.clients && session.mixer.clients.size > 0));

    if (!isStreaming) {
      console.log(`🔄 Session ${sessionId} reported inactive (no streaming clients)`);
      return res.status(200).json({ ok: false, reason: 'inactive', streamAlive: false });
    }

    if (session.mixer.currentTrack && session.mixer.currentTrack.path) {
      console.log(`🔄 Triggering heartbeat + snapshot for session ${sessionId} (${session.mixer.eventClients.size} clients)`);
      await session.mixer.broadcastHeartbeat('manual-refresh', { force: true });
      session.mixer.broadcastExplorerSnapshot(true, 'manual-refresh').catch(err => {
        console.error('🔄 Failed to broadcast explorer snapshot during refresh:', err);
      });

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
        sessionId,
        fingerprint: fingerprintRegistry.getFingerprintForSession(sessionId)
      });
    } else {
      console.log(`🔄 Session ${sessionId} has no valid track to broadcast`);
      res.status(200).json({ ok: false, reason: 'no_track', streamAlive: true });
    }

  } catch (error) {
    console.error('🔄 SSE refresh error:', error);
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
      console.log(`🔄 Triggering heartbeat + snapshot for session ${session.sessionId} (${session.mixer.eventClients.size} clients)`);
      await session.mixer.broadcastHeartbeat('manual-refresh-simple', { force: true });
      session.mixer.broadcastExplorerSnapshot(true, 'manual-refresh-simple').catch(err => {
        console.error('🔄 Failed to broadcast explorer snapshot during simple refresh:', err);
      });

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
app.get('/search', (req, res) => {
  const query = req.query.q;
  const limit = parseInt(req.query.limit) || 50;

  if (!query || query.length < 2) {
    return res.json({ results: [], query: query, total: 0 });
  }

  console.log(`🔍 Fuzzy search: "${query}" (limit: ${limit})`);

  // Enhanced fuzzy search SQL - searches decoded paths, metadata, and path segments
  const searchQuery = `
    SELECT
      identifier,
      CAST(path_b64 AS TEXT) as path_b64,
      CAST(beets_json_b64 AS TEXT) as beets_json_b64
    FROM tracks
    WHERE
      LOWER(CAST(path_b64 AS TEXT)) LIKE LOWER(?)
      OR identifier LIKE ?
    ORDER BY
      CASE
        -- Exact matches in artist/title get priority
        WHEN LOWER(CAST(beets_json_b64 AS TEXT)) LIKE LOWER(?) THEN 1
        -- Path segment matches get second priority
        WHEN LOWER(CAST(path_b64 AS TEXT)) LIKE LOWER(?) THEN 2
        -- SHA matches get third priority
        WHEN identifier LIKE ? THEN 3
        ELSE 4
      END,
      LENGTH(CAST(path_b64 AS TEXT))
    LIMIT ?
  `;

  const searchPattern    = `%${query}%`;
  const metadataPattern  = `%${query}%`;
  const pathPattern      = `%${query}%`;
  const md5Pattern       = `%${query}%`;

  db.all(searchQuery, [searchPattern, searchPattern, metadataPattern, pathPattern, md5Pattern, limit], (err, rows) => {
    if (err) {
      console.error('Search error:', err);
      return res.status(500).json({ error: 'Search failed' });
    }

    const results = rows.map(row => {
      try {
        // Decode base64 path
        const decodedPath = Buffer.from(row.path_b64, 'base64').toString('utf8');

        // Try to decode beets metadata
        let metadata = {};
        if (row.beets_json_b64) {
          try {
            const beetsJson = Buffer.from(row.beets_json_b64, 'base64').toString('utf8');
            metadata = JSON.parse(beetsJson);
          } catch (e) {
            // Skip metadata decode errors
          }
        }

        // Extract filename and path segments for fzf-style navigation
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
          albumCover: metadata.album.artpath || '/images/albumcover.png',
          title: metadata.title || filename,
          artist: metadata.artist || segments.pathArtist || '',
          album: metadata.album || segments.pathAlbum || '',
          year: metadata.year || segments.year || '',
          // fzf-style matched text highlighting could be added here
          displayText: `${metadata.artist || segments.pathArtist || 'Unknown'} - ${metadata.title || filename}`,
          // Include searchable path info
          searchableText: `${decodedPath} ${metadata.artist || ''} ${metadata.title || ''} ${metadata.album || ''} ${segments.tranche} ${segments.year} ${segments.month}`
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
  });
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
  const session = await getSessionForRequest(req);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    ...session.mixer.getStats(),
    created: session.created,
    lastAccess: session.lastAccess
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

app.post('/pca/explore', async (req, res) => {
  try {
    const { trackId, config = {} } = req.body;

    if (!trackId) {
      return res.status(400).json({ error: 'trackId is required' });
    }

    // Use PCA by default with new explore endpoint
    const pcaConfig = { usePCA: true, ...config };
    const result = await radialSearch.exploreFromTrack(trackId, pcaConfig);
    res.json(result);
  } catch (error) {
    console.error('PCA explore error:', error);
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

// Zoom mode commands (microscope, magnifying glass, binoculars)
app.post('/session/zoom/:mode', async (req, res) => {
  const mode = req.params.mode;
  const session = await getSessionForRequest(req, { createIfMissing: false });

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const validModes = ['microscope', 'magnifying', 'binoculars'];
  if (!validModes.includes(mode)) {
    return res.status(400).json({ error: 'Invalid zoom mode' });
  }

  try {
    console.log(`🔍 Zoom mode ${mode} for session ${session.sessionId}`);

    if (!session.mixer.setExplorerResolution) {
      return res.status(400).json({ error: 'Session does not support zoom controls' });
    }

    const normalizedMode = mode === 'magnifying' ? 'magnifying_glass' : mode;
    const changed = session.mixer.setExplorerResolution(normalizedMode);

    if (changed) {
      await session.mixer.broadcastHeartbeat('zoom-change', { force: false });
      session.mixer.broadcastExplorerSnapshot(true, 'zoom-change').catch(err => {
        console.error('Failed to broadcast explorer snapshot after zoom change:', err);
      });
    }

    const modeEmoji = {
      'microscope': '🔬',
      'magnifying': '🔍',
      'magnifying_glass': '🔍',
      'binoculars': '🔭'
    };

    const emoji = modeEmoji[mode] || modeEmoji[normalizedMode] || '';

    res.json({
      message: `${emoji} ${mode} mode activated`,
      mode,
      sessionId: session.sessionId,
      resolution: session.mixer.explorerResolution,
      broadcast: changed
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
  const { trackMd5, direction, source = 'user', fingerprint: requestFingerprint } = req.body;
  const normalizedSource = typeof source === 'string' ? source.toLowerCase() : 'user';

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
    if (normalizedSource === 'user') {
      console.log(`🎯 User selected specific track: ${trackMd5} (direction: ${direction})`);

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
      const cleanMd5 = typeof trackMd5 === 'string' ? trackMd5 : null;
      const advertisedDirection = typeof direction === 'string' ? direction : null;
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

    res.json({
      // Acknowledgment
      nextTrack: preparedNextId,
      pendingTrack: pendingCurrentId,

      // Sync state: current track + timing
      currentTrack: currentTrackId,
      duration: Math.round(duration),
      remaining: Math.round(remaining),

      sessionId: session.sessionId,
      fingerprint: fingerprintRegistry.getFingerprintForSession(session.sessionId)
    });
  } catch (error) {
    console.error('Next track selection error:', error);
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

app.get('/sessions/now-playing', (req, res) => {
  const sessions = [];

  const collectSessions = (collection, isEphemeral = false) => {
    for (const [sessionId, session] of collection) {
      const mixer = session.mixer;
      if (!mixer || !mixer.currentTrack) {
        continue;
      }

      const track = mixer.currentTrack;
      let durationSeconds = null;
      if (typeof mixer.getAdjustedTrackDuration === 'function') {
        const adjusted = Number(mixer.getAdjustedTrackDuration());
        if (Number.isFinite(adjusted) && adjusted > 0) {
          durationSeconds = adjusted;
        }
      }
      if (durationSeconds === null && typeof track.length === 'number') {
        durationSeconds = track.length;
      }

      const trackStart = mixer.trackStartTime || session.lastAccess || null;
      const elapsedMs = trackStart ? Date.now() - trackStart : null;

      sessions.push({
        sessionId,
        md5: track.identifier || null,
        title: track.title || null,
        artist: track.artist || null,
        nextTrack: mixer.nextTrack ? {
          identifier: mixer.nextTrack.identifier || null,
          title: mixer.nextTrack.title || null,
          artist: mixer.nextTrack.artist || null
        } : null,
        elapsedMs: elapsedMs !== null ? Math.max(elapsedMs, 0) : null,
        durationMs: durationSeconds !== null ? Math.round(durationSeconds * 1000) : null,
        clients: mixer.clients ? mixer.clients.size : 0,
        isEphemeral: isEphemeral || Boolean(session.isEphemeral)
      });
    }
  };

  collectSessions(audioSessions, false);
  collectSessions(ephemeralSessions, true);

  res.json({
    status: 'ok',
    timestamp: Date.now(),
    sessions
  });
});

// Clean up inactive sessions
setInterval(() => {
  const now = new Date();
  const timeout = 60 * 60 * 1000; // 60 minutes (longer for smart reconnection)

  for (const [sessionId, session] of audioSessions) {
    // Don't clean up sessions with active connections or recent activity
    const hasActiveAudioClients = session.mixer.clients && session.mixer.clients.size > 0;
    const hasActiveEventClients = session.mixer.eventClients && session.mixer.eventClients.size > 0;
    const isActiveStreaming = session.mixer.isActive;
    const hasRecentActivity = (now - session.lastAccess) < timeout;

    // Keep session alive if:
    // 1. Has active audio clients, OR
    // 2. Has active SSE clients (frontend monitoring), OR
    // 3. Is actively streaming, OR
    // 4. Had recent activity (within timeout)
    if (hasActiveAudioClients || hasActiveEventClients || isActiveStreaming || hasRecentActivity) {
      continue; // Keep session alive
    }

    console.log(`🧹 Cleaning up inactive session: ${sessionId} (idle: ${Math.round((now - session.lastAccess) / 60000)}m)`);
    session.mixer.destroy();
    audioSessions.delete(sessionId);
  }
}, 60 * 1000); // Check every minute

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');

  for (const [sessionId, session] of audioSessions) {
    console.log(`Destroying session: ${sessionId}`);
    session.mixer.destroy();
  }

  radialSearch.close();
  process.exit(0);
});

const server = app.listen(port, () => {
  console.log(`🎵 Audio streaming server listening at http://localhost:${port}`);
  console.log('🎯 No Icecast needed - direct Node.js streaming!');
  console.log(`🔒 Server protected by PID ${process.pid}`);
});

// Handle port conflicts gracefully
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ PORT CONFLICT: Port ${port} is already in use!`);
    console.error(`❌ Another server instance may be running`);
    console.error(`❌ Check: lsof -i :${port} or kill existing processes`);

    // Clean up our PID file since we failed to start
    try {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
        console.log(`🧹 Cleaned up PID file after port conflict`);
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
