const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const DriftAudioMixer = require('./drift-audio-mixer');
const RadialSearchService = require('./radial-search');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = 3001;
const pidFile = path.join(__dirname, 'server.pid');


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

// Master session - one active session per server
let masterSession = null;
let nextSessionPreloaded = null; // Pre-loaded session ready to become master
const audioSessions = new Map(); // Keep for backward compatibility

// Initialize radial search service
const radialSearch = new RadialSearchService();

// Initialize database connection
const dbPath = path.join(__dirname, '../results.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('📊 Connected to music database');
  }
});

// Preloading initialization function
async function initializeWithPreloading() {
  try {
    await radialSearch.initialize();

    // Create and preload master session immediately
    console.log('🚀 Preloading master session on server startup...');
    const preloadedMaster = await createPreloadedSession('startup_master');
    masterSession = preloadedMaster;

    // Immediately create the next preloaded session
    console.log('🔄 Preparing next session for instant switchover...');
    nextSessionPreloaded = await createPreloadedSession('preload_next');

    console.log('✅ Server fully preloaded and ready for instant responses');
  } catch (err) {
    console.error('Failed to initialize with preloading:', err);
  }
}

// Create a fully preloaded session with first track ready
async function createPreloadedSession(prefix) {
  const sessionId = `${prefix}_` + crypto.randomBytes(4).toString('hex');
  console.log(`🎯 Creating preloaded session: ${sessionId}`);

  const mixer = new DriftAudioMixer(sessionId, radialSearch);

  // Preload the first track and get it ready to crossfade
  try {
    await mixer.startDriftPlayback();
    console.log(`✅ Session ${sessionId} preloaded with first track ready`);
  } catch (error) {
    console.error(`❌ Failed to preload session ${sessionId}:`, error);
  }

  const session = {
    sessionId,
    mixer,
    created: new Date(),
    lastAccess: new Date(),
    isPreloaded: true
  };

  // Store in map for compatibility
  audioSessions.set(sessionId, session);
  return session;
}

// Start preloading initialization
initializeWithPreloading();

// Serve static files and middleware
app.use(express.json());

// Session middleware (infrastructure only - not changing behavior yet)
app.use(session({
  secret: process.env.SESSION_SECRET || 'tsnotfyi-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: true, // Create session for every visitor
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: false // Set to true in production with HTTPS
  },
  name: 'tsnotfyi.sid' // Custom session cookie name
}));

app.use(express.static('public'));
app.use( '/images', express.static('images') );
app.use( '/Volumes', express.static('/Volumes', { fallthrough: false }) );

// Get master session (uses preloaded sessions for instant response)
app.post('/create-session', async (req, res) => {
  const masterSess = await getPreloadedMasterSession();

  console.log(`🎯 Returning preloaded master session: ${masterSess.sessionId}`);

  res.json({
    sessionId: masterSess.sessionId,
    streamUrl: `/stream/${masterSess.sessionId}`,
    webUrl: `/session/${masterSess.sessionId}`,
    preloaded: true
  });
});

// NOTE: Multi-session API endpoints removed - see SESSIONS_ROADMAP.md for reintroduction plan

// Get preloaded master session (instant response)
async function getPreloadedMasterSession() {
  if (!masterSession) {
    console.log('⚠️ Master session not ready, falling back to quick creation');
    const sessionId = 'emergency_master_' + crypto.randomBytes(4).toString('hex');
    const mixer = new DriftAudioMixer(sessionId, radialSearch);

    masterSession = {
      sessionId,
      mixer,
      created: new Date(),
      lastAccess: new Date(),
      isPreloaded: false
    };

    audioSessions.set(sessionId, masterSession);

    // Start drift playback asynchronously
    mixer.startDriftPlayback().catch(err => {
      console.error('Emergency session drift startup failed:', err);
    });
  }

  // Update access time
  masterSession.lastAccess = new Date();

  // Immediately prepare the next session if we just consumed the preloaded one
  if (masterSession.isPreloaded && !nextSessionPreloaded) {
    console.log('🔄 Master session consumed, preparing next preloaded session...');

    // Asynchronously prepare the next session (don't block the response)
    createPreloadedSession('next_preload').then(session => {
      nextSessionPreloaded = session;
      console.log('✅ Next preloaded session ready');
    }).catch(err => {
      console.error('Failed to prepare next session:', err);
    });
  }

  return masterSession;
}

// Get or create the master session (legacy/backward compatibility)
function getMasterSession() {
  if (!masterSession) {
    const sessionId = 'compat_master_' + crypto.randomBytes(4).toString('hex');
    console.log(`🎯 Creating backward compatibility master session: ${sessionId}`);

    const mixer = new DriftAudioMixer(sessionId, radialSearch);
    masterSession = {
      sessionId,
      mixer,
      created: new Date(),
      lastAccess: new Date(),
      isPreloaded: false
    };

    // Also store in map for backward compatibility
    audioSessions.set(sessionId, masterSession);
    console.log(`🎯 Master session ${sessionId} created and ready`);
  }

  masterSession.lastAccess = new Date();
  return masterSession;
}

// Helper function to get or create session (backward compatibility)
function getOrCreateSession(sessionId) {
  // For new architecture, always return master session regardless of requested sessionId
  console.log(`🔄 Redirecting request for session ${sessionId} to master session`);
  return getMasterSession();
}

// Helper: Get audio session for a request (uses Express session infrastructure)
// For now, still returns master session - infrastructure only, no behavior change
function getAudioSessionForRequest(req) {
  const expressSessionId = req.session?.id;

  // Log session ID for verification
  if (expressSessionId) {
    console.log(`🆔 Request from Express session: ${expressSessionId.substring(0, 8)}...`);
  }

  // If URL has explicit session ID, use that (existing named session behavior)
  if (req.params.sessionId) {
    console.log(`🆔 Using URL-based session: ${req.params.sessionId}`);
    return audioSessions.get(req.params.sessionId) || masterSession;
  }

  // For now, always return master session (no behavior change)
  // In future: map expressSessionId to individual audio sessions
  return masterSession;
}

// Simplified stream endpoint - uses master session
app.get('/stream', (req, res) => {
  console.log(`🔥 DEBUG: Stream request received (simplified endpoint)`);

  const session = getAudioSessionForRequest(req); // Use helper (still returns master)
  console.log(`Client connecting to master stream: ${session.sessionId}`);

  // Update last access time
  session.lastAccess = new Date();

  // Add client to mixer
  session.mixer.addClient(res);
});

// Stream endpoint - this is where browsers connect for audio (backward compatibility)
app.get('/stream/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  console.log(`🔥 DEBUG: Stream request received for session: ${sessionId}`);

  const session = getOrCreateSession(sessionId);

  console.log(`Client connecting to stream: ${sessionId}`);

  // Update last access time
  session.lastAccess = new Date();

  // Add client to mixer
  session.mixer.addClient(res);
});

// NOTE: Named session creation endpoints removed - see SESSIONS_ROADMAP.md for reintroduction plan

// Session page
app.get('/session/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = audioSessions.get(sessionId);
  const isFollowMode = req.query.mode === 'follow';

  if (!session) {
    console.log(`⚠️ Session '${sessionId}' not found, serving page anyway (master session pattern)`);
  }

  if (isFollowMode) {
    console.log(`👁️ Serving session page in follow mode for: ${sessionId}`);
  } else {
    console.log(`🎮 Serving session page in control mode for: ${sessionId}`);
  }

  // TODO: Create minimal.html for lightweight session view, or build session-specific UI
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Simplified events endpoint - uses master session
app.get('/events', async (req, res) => {
  console.log(`📡 SSE connection attempt (simplified endpoint) - headers:`, req.headers.accept);

  try {
    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const session = await getPreloadedMasterSession(); // Use preloaded master session

    // Send initial connection event
    res.write('data: {"type":"connected","sessionId":"' + session.sessionId + '"}\n\n');

    console.log(`📡 Found master session, adding SSE client`);
    console.log(`📡 Master session currently has ${session.mixer.eventClients.size} SSE clients before adding`);
    session.mixer.addEventClient(res);
    console.log(`📡 Master session now has ${session.mixer.eventClients.size} SSE clients after adding`);

    // Send current track info ONLY if session is actively streaming a valid track
    if (session.mixer.currentTrack &&
        session.mixer.isActive &&
        session.mixer.currentTrack.title &&
        session.mixer.currentTrack.title.trim() !== '') {
      console.log('📡 Sending current track info to new SSE client');
      session.mixer.broadcastTrackEvent();
    } else {
      console.log('📡 No valid current track to broadcast, skipping initial track event');
    }

    // Handle client disconnect
    req.on('close', () => {
      if (session && session.mixer.removeEventClient) {
        session.mixer.removeEventClient(res);
      }
    });

  } catch (error) {
    console.error('📡 SSE connection error:', error);
    res.status(500).json({ error: 'SSE connection failed' });
  }
});

// Server-Sent Events endpoint for real-time updates (backward compatibility)
app.get('/events/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;

  console.log(`📡 SSE connection attempt for session: ${sessionId}`);

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Send initial connection event
  res.write('data: {"type":"connected","sessionId":"' + sessionId + '"}\n\n');

  // Get or create session using the helper function
  const session = getOrCreateSession(sessionId);

  console.log(`📡 Found/created session ${sessionId}, adding SSE client`);
  console.log(`📡 Session ${sessionId} currently has ${session.mixer.eventClients.size} SSE clients before adding`);
  session.mixer.addEventClient(res);
  console.log(`📡 Session ${sessionId} now has ${session.mixer.eventClients.size} SSE clients after adding`);

  // Send current track info ONLY if session is actively streaming a valid track
  if (session.mixer.currentTrack &&
      session.mixer.isActive &&
      session.mixer.currentTrack.title &&
      session.mixer.currentTrack.title.trim() !== '') {
    console.log('📡 Sending current track info to new SSE client');
    session.mixer.broadcastTrackEvent();
  } else {
    console.log('📡 No valid current track to broadcast, skipping initial track event');
  }

  // Handle client disconnect
  req.on('close', () => {
    if (session && session.mixer.removeEventClient) {
      session.mixer.removeEventClient(res);
    }
  });
});

// SSE refresh endpoint - triggers server to rebroadcast current state via SSE (pull/monadic)
app.post('/refresh-sse', async (req, res) => {
  const sessionId = req.body.sessionId || 'master';

  console.log(`🔄 SSE refresh request from client for session: ${sessionId}`);

  try {
    const session = audioSessions.get(sessionId);

    if (!session) {
      console.log(`🔄 No session found for refresh request: ${sessionId}`);
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.mixer || !session.mixer.isActive) {
      console.log(`🔄 Session ${sessionId} is not active, cannot refresh`);
      return res.status(200).json({ ok: false, reason: 'inactive' });
    }

    // Trigger SSE broadcast if we have a valid track (just needs path)
    if (session.mixer.currentTrack && session.mixer.currentTrack.path) {
      console.log(`🔄 Triggering SSE broadcast for session ${sessionId} (${session.mixer.eventClients.size} clients)`);
      session.mixer.broadcastTrackEvent();
      res.status(200).json({ ok: true });
    } else {
      console.log(`🔄 Session ${sessionId} has no valid track to broadcast`);
      res.status(200).json({ ok: false, reason: 'no_track' });
    }

  } catch (error) {
    console.error('🔄 SSE refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Simplified SSE refresh endpoint (uses master session)
app.post('/refresh-sse-simple', async (req, res) => {
  console.log('🔄 Simple SSE refresh request from client');

  try {
    const session = await getPreloadedMasterSession();

    if (!session) {
      console.log('🔄 No master session found for refresh request');
      return res.status(404).json({ error: 'Master session not found' });
    }

    if (!session.mixer || !session.mixer.isActive) {
      console.log('🔄 Master session is not active, cannot refresh');
      return res.status(200).json({ ok: false, reason: 'inactive' });
    }

    // Trigger SSE broadcast if we have a valid track (just needs path)
    if (session.mixer.currentTrack && session.mixer.currentTrack.path) {
      console.log(`🔄 Triggering SSE broadcast for master session (${session.mixer.eventClients.size} clients)`);
      session.mixer.broadcastTrackEvent();
      res.status(200).json({ ok: true });
    } else {
      console.log('🔄 Master session has no valid track to broadcast');
      res.status(200).json({ ok: false, reason: 'no_track' });
    }

  } catch (error) {
    console.error('🔄 Simple SSE refresh error:', error);
    res.status(500).json({ error: error.message });
  }
});


// SHA-based journey endpoints
// Start journey from specific track: /md5
app.get('/:md5', async (req, res, next) => {
  const md5 = req.params.md5;

  // Validate MD5 format (32-character hex string)
  if (!/^[a-f0-9]{32}$/.test(md5)) {
    return next();
  }

  const sessionId = md5; // Use MD5 as session ID
  console.log(`🎯 Starting journey from track MD5: ${md5} (session: ${sessionId})`);

  try {
    // Create or get session with MD5-based ID
    let session = audioSessions.get(sessionId);
    if (!session) {
      console.log(`Creating new session for MD5: ${sessionId}`);
      session = await createPreloadedSession(`md5_${md5.substring(0, 8)}`);
      session.sessionId = sessionId; // Override with full MD5
      audioSessions.set(sessionId, session);
    }

    // Set the specific track as the starting point
    if (session.mixer.setNextTrack) {
      session.mixer.setNextTrack(md5);
    } else if (session.mixer.driftPlayer) {
      session.mixer.selectedNextTrackMd5 = md5;
    }

    // Force immediate transition to the specified track
    if (session.mixer.triggerGaplessTransition) {
      session.mixer.triggerGaplessTransition();
    }

    // Wait for the track to be loaded and ready before serving the page
    console.log('🎯 Waiting for track to be loaded and ready...');
    let attempts = 0;
    const maxAttempts = 20; // 10 seconds max wait

    while (attempts < maxAttempts) {
      if (session.mixer.currentTrack &&
          session.mixer.currentTrack.title &&
          session.mixer.currentTrack.title.trim() !== '' &&
          session.mixer.isActive) {
        console.log(`🎯 Track ready: ${session.mixer.currentTrack.title}`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms
      attempts++;
    }

    if (attempts >= maxAttempts) {
      console.log('⚠️ Timeout waiting for track to load, serving page anyway');
    }

    // Instead of redirecting, serve the main page with the starting track data injected
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    // Inject starting track data into the page
    const scriptInjection = `
    <script>
        window.startingTrackMd5 = '${md5}';
        window.sessionId = '${sessionId}';
        console.log('🎯 Starting with track MD5:', window.startingTrackMd5);
        console.log('🎯 Using session ID:', window.sessionId);
    </script>
    `;

    // Insert the script before the closing </head> tag
    html = html.replace('</head>', scriptInjection + '\n</head>');

    res.send(html);
  } catch (error) {
    console.error('MD5 journey start error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Contrived journey: start at md51 with only md52 as next option
app.get('/:md51/:md52', async (req, res, next) => {
  const { md51, md52 } = req.params;

  // Validate both MD5 formats
  if (!/^[a-f0-9]{32}$/.test(md51) || !/^[a-f0-9]{32}$/.test(md52)) {
    return next();
  }

  const sessionId = `${md51}_${md52}`; // Use combined MD5s as session ID
  console.log(`🎯 Contrived journey: ${md51} → ${md52} (session: ${sessionId})`);

  try {
    // Create or get session with combined MD5-based ID
    let session = audioSessions.get(sessionId);
    if (!session) {
      console.log(`Creating new contrived session: ${sessionId}`);
      session = await createPreloadedSession(`contrived_${md51.substring(0, 4)}_${md52.substring(0, 4)}`);
      session.sessionId = sessionId; // Override with combined SHAs
      audioSessions.set(sessionId, session);
    }

    // Set up the contrived sequence
    if (session.mixer.setContrivedSequence) {
      session.mixer.setContrivedSequence(md51, md52);
    } else if (session.mixer.driftPlayer) {
      // Store both tracks for the contrived journey
      session.mixer.selectedNextTrackMd5 = md51;
      session.mixer.contrivedNextTrackMd5 = md52;
    }

    // Force transition to start the sequence
    if (session.mixer.triggerGaplessTransition) {
      session.mixer.triggerGaplessTransition();
    }

    res.redirect(`/session/${sessionId}`);
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
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Simplified status endpoint - uses master session
app.get('/status', (req, res) => {
  const session = getMasterSession(); // Always use master session

  res.json({
    ...session.mixer.getStats(),
    created: session.created,
    lastAccess: session.lastAccess
  });
});

// Session status (backward compatibility)
app.get('/status/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = audioSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    ...session.mixer.getStats(),
    created: session.created,
    lastAccess: session.lastAccess
  });
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
app.post('/session/:sessionId/reset-drift', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = audioSessions.get(sessionId);

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

// User directional command
app.post('/session/:sessionId/flow/:direction', (req, res) => {
  const sessionId = req.params.sessionId;
  const direction = req.params.direction;
  const session = audioSessions.get(sessionId);

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

// Force immediate track change (test command)
app.post('/session/:sessionId/force-next', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = audioSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    console.log(`🎮 Force next track for session ${sessionId}`);

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

// Zoom mode commands (microscope, magnifying glass, binoculars)
app.post('/session/:sessionId/zoom/:mode', (req, res) => {
  const sessionId = req.params.sessionId;
  const mode = req.params.mode;
  const session = audioSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const validModes = ['microscope', 'magnifying', 'binoculars'];
  if (!validModes.includes(mode)) {
    return res.status(400).json({ error: 'Invalid zoom mode' });
  }

  try {
    console.log(`🔍 Zoom mode ${mode} for session ${sessionId}`);

    // For now, just acknowledge the command - implementation can be added later
    const modeEmoji = {
      'microscope': '🔬',
      'magnifying': '🔍',
      'binoculars': '🔭'
    };

    res.json({
      message: `${modeEmoji[mode]} ${mode} mode activated`,
      mode: mode,
      sessionId: sessionId
    });
  } catch (error) {
    console.error('Zoom mode error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Simplified next track endpoint - uses master session
app.post('/next-track', (req, res) => {
  const { trackMd5, direction } = req.body;
  const session = getAudioSessionForRequest(req); // Use helper (still returns master)

  if (!trackMd5) {
    return res.status(400).json({ error: 'Track MD5 is required' });
  }

  try {
    console.log(`🎯 User selected specific track: ${trackMd5} (direction: ${direction})`);

    // Set the specific next track by MD5
    if (session.mixer.setNextTrack) {
      session.mixer.setNextTrack(trackMd5);
    } else if (session.mixer.driftPlayer) {
      // Store the selected track MD5 for next transition
      session.mixer.selectedNextTrackMd5 = trackMd5;
      if (direction) {
        session.mixer.driftPlayer.currentDirection = direction;
      }
    }

    // Calculate timing info for sync check
    const duration = session.mixer.getAdjustedTrackDuration() * 1000; // Convert to ms
    const elapsed = session.mixer.trackStartTime ? (Date.now() - session.mixer.trackStartTime) : 0;
    const remaining = Math.max(0, duration - elapsed);

    res.json({
      // Acknowledgment
      nextTrack: trackMd5,

      // Sync state: current track + timing
      currentTrack: session.mixer.currentTrack?.identifier || null,
      duration: Math.round(duration),
      remaining: Math.round(remaining)
    });
  } catch (error) {
    console.error('Next track selection error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update next track by specific MD5 for session (backward compatibility)
app.post('/session/:sessionId/next-track', (req, res) => {
  const sessionId = req.params.sessionId;
  const { trackMd5, direction } = req.body;
  const session = audioSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!trackMd5) {
    return res.status(400).json({ error: 'Track MD5 is required' });
  }

  try {
    console.log(`🎯 User selected specific track: ${trackMd5} (direction: ${direction}) for session ${sessionId}`);

    // Set the specific next track by MD5
    if (session.mixer.setNextTrack) {
      session.mixer.setNextTrack(trackMd5);
    } else if (session.mixer.driftPlayer) {
      // Store the selected track MD5 for next transition
      session.mixer.selectedNextTrackMd5 = trackMd5;
      if (direction) {
        session.mixer.driftPlayer.currentDirection = direction;
      }
    }

    // Calculate timing info for sync check
    const duration = session.mixer.getAdjustedTrackDuration() * 1000; // Convert to ms
    const elapsed = session.mixer.trackStartTime ? (Date.now() - session.mixer.trackStartTime) : 0;
    const remaining = Math.max(0, duration - elapsed);

    res.json({
      // Acknowledgment
      nextTrack: trackMd5,

      // Sync state: current track + timing
      currentTrack: session.mixer.currentTrack?.identifier || null,
      duration: Math.round(duration),
      remaining: Math.round(remaining)
    });
  } catch (error) {
    console.error('Next track selection error:', error);
    res.status(500).json({ error: error.message });
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

// Clean up inactive sessions
setInterval(() => {
  const now = new Date();
  const timeout = 30 * 60 * 1000; // 30 minutes (much longer)

  for (const [sessionId, session] of audioSessions) {
    // Don't clean up sessions with active audio streaming
    const hasActiveClients = session.mixer.clients && session.mixer.clients.size > 0;
    const isActiveStreaming = session.mixer.isActive;

    if (!hasActiveClients && !isActiveStreaming && now - session.lastAccess > timeout) {
      console.log(`Cleaning up inactive session: ${sessionId}`);
      session.mixer.destroy();
      audioSessions.delete(sessionId);
    }
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
