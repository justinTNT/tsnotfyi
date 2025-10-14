Comprehensive Instructions: Refactor to Audio-First Session Architecture

  Objective

  Refactor the application so that the audio stream is the source of truth for session ID and health, with SSE as a
  secondary metadata channel. This eliminates split-session bugs and aligns session state with user perception (what they
  hear).

  Current Problems

  1. SSE connects first and creates a session
  2. Audio connects second and creates a DIFFERENT session (express-session cookie not yet available)
  3. Result: Audio plays on session A, metadata comes from session B
  4. Health monitoring is unclear - which connection matters?

  Target Architecture

  Session Lifecycle

  1. Page load: Establish session ID (from cookie/localStorage or create new)
  2. SSE connects: To the established session (metadata channel)
  3. User clicks play: Audio connects to the same session (audio channel)
  4. Health monitoring: Audio timeupdate = primary, SSE = secondary
  5. Recovery: Audio dies → full restart; SSE dies → reconnect to audio's session

  ---
  Implementation Steps

  Phase 1: Session Bootstrap (client-side)

  File: public/scripts/page.js

  1.1 Add session bootstrap function (before DOMContentLoaded)

  Add this function early in the file, before connectSSE() is called:

  // Session establishment - must happen before SSE or audio connect
  async function establishSession() {
    console.log('🔧 Establishing session...');

    // Check if we have a session in localStorage
    const cachedSessionId = localStorage.getItem('audioSessionId');
    if (cachedSessionId) {
      console.log(`🔧 Found cached session: ${cachedSessionId}`);
      state.sessionId = cachedSessionId;
      return cachedSessionId;
    }

    // No cached session, create a new one
    try {
      const response = await fetch('/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.status}`);
      }

      const data = await response.json();
      const sessionId = data.sessionId;

      console.log(`🔧 Created new session: ${sessionId}`);
      state.sessionId = sessionId;
      localStorage.setItem('audioSessionId', sessionId);

      return sessionId;
    } catch (error) {
      console.error('❌ Failed to establish session:', error);
      throw error;
    }
  }

  1.2 Update SSE connection to use explicit session

  Find the connectSSE() function and modify it:

  Before:
  function connectSSE() {
    const eventsUrl = state.eventsEndpoint || '/events';
    const eventSource = new EventSource(eventsUrl);
    // ...
  }

  After:
  function connectSSE() {
    if (!state.sessionId) {
      console.error('❌ Cannot connect SSE: no session ID');
      return;
    }

    const eventsUrl = `/events?session=${state.sessionId}`;
    console.log(`🔌 Connecting SSE to session: ${state.sessionId}`);

    const eventSource = new EventSource(eventsUrl);
    connectionHealth.currentEventSource = eventSource;
    // ... rest of existing code
  }

  1.3 Update audio source to use explicit session

  Find where elements.audio.src is set and update it:

  Before:
  elements.audio.src = state.streamUrl;

  After:
  if (!state.sessionId) {
    console.error('❌ Cannot set audio source: no session ID');
    return;
  }
  const streamUrl = `/stream?session=${state.sessionId}`;
  elements.audio.src = streamUrl;
  console.log(`🎵 Audio connecting to session: ${state.sessionId}`);

  Do this in ALL locations where audio.src is set (search for elements.audio.src and streamElement.src).

  1.4 Update initialization sequence

  Find where connectSSE() is called (around line 1801) and wrap it:

  Before:
  connectSSE();

  After:
  // Initialize session before connecting anything
  (async function initializeApp() {
    try {
      await establishSession();
      connectSSE();
    } catch (error) {
      console.error('❌ App initialization failed:', error);
      // Show error to user
    }
  })();

  ---
  Phase 2: Audio-First Health Monitoring

  2.1 Add audio health tracker

  Add this after the connectionHealth object definition:

  const audioHealth = {
    lastTimeUpdate: null,
    bufferingStarted: null,
    isHealthy: false,
    checkInterval: null
  };

  // Audio event handlers for health tracking
  elements.audio.addEventListener('timeupdate', () => {
    audioHealth.lastTimeUpdate = Date.now();
    audioHealth.bufferingStarted = null;
    audioHealth.isHealthy = true;

    connectionHealth.audio.status = 'connected';
    updateConnectionHealthUI();
  });

  elements.audio.addEventListener('waiting', () => {
    console.log('⏳ Audio buffering...');
    audioHealth.bufferingStarted = Date.now();
  });

  elements.audio.addEventListener('playing', () => {
    console.log('▶️ Audio playing');
    audioHealth.bufferingStarted = null;
    audioHealth.isHealthy = true;
  });

  elements.audio.addEventListener('error', (e) => {
    console.error('❌ Audio error - session is dead');
    audioHealth.isHealthy = false;
    handleDeadAudioSession();
  });

  elements.audio.addEventListener('stalled', () => {
    console.error('❌ Audio stalled - network failed');
    audioHealth.isHealthy = false;
  });

  2.2 Add health check interval

  // Start health monitoring
  function startAudioHealthMonitoring() {
    if (audioHealth.checkInterval) {
      clearInterval(audioHealth.checkInterval);
    }

    audioHealth.checkInterval = setInterval(() => {
      if (!audioHealth.lastTimeUpdate) {
        return; // Audio hasn't started yet
      }

      const timeSinceUpdate = Date.now() - audioHealth.lastTimeUpdate;
      const isBuffering = audioHealth.bufferingStarted !== null;
      const bufferingDuration = isBuffering ? (Date.now() - audioHealth.bufferingStarted) : 0;

      // Dead session: no timeupdate for 12 seconds
      if (timeSinceUpdate > 12000) {
        console.error(`❌ Audio session dead: no timeupdate for ${(timeSinceUpdate/1000).toFixed(1)}s`);
        audioHealth.isHealthy = false;
        handleDeadAudioSession();
        return;
      }

      // Struggling session: buffering for 8+ seconds
      if (bufferingDuration > 8000) {
        console.warn(`⚠️ Audio struggling: buffering for ${(bufferingDuration/1000).toFixed(1)}s`);
        connectionHealth.audio.status = 'degraded';
        updateConnectionHealthUI();
      }
    }, 2000); // Check every 2 seconds
  }

  // Call this when audio starts playing
  function handleDeadAudioSession() {
    console.error('💀 Audio session is dead - restarting everything');

    // Clear cached session
    localStorage.removeItem('audioSessionId');
    state.sessionId = null;

    // Close SSE
    if (connectionHealth.currentEventSource) {
      connectionHealth.currentEventSource.close();
    }

    // Reconnect everything
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  }

  Call startAudioHealthMonitoring() in the startAudio() function after setting up the audio element.

  2.3 Update SSE reconnection logic

  Find the SSE error and close handlers and update them to reconnect to the audio's session:

  eventSource.onerror = (error) => {
    console.error('❌ SSE error:', error);

    // SSE died, but is audio still playing?
    if (audioHealth.isHealthy) {
      console.log('🔄 SSE died but audio healthy - reconnecting SSE to same session');
      setTimeout(() => {
        connectSSE(); // Reconnects to state.sessionId
      }, 2000);
    } else {
      console.log('🔄 SSE died and audio unhealthy - full restart needed');
      handleDeadAudioSession();
    }
  };

  ---
  Phase 3: Server-Side Session Handling

  File: server.js

  3.1 Update /events endpoint to accept session parameter

  Find the /events endpoint and modify:

  app.get('/events', async (req, res) => {
    console.log(`📡 SSE connection attempt`);

    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      // Get session from query param or cookie
      const requestedSessionId = req.query.session;
      let session;

      if (requestedSessionId) {
        console.log(`📡 SSE requesting specific session: ${requestedSessionId}`);
        session = getSessionById(requestedSessionId);

        if (!session) {
          console.error(`📡 Requested session ${requestedSessionId} not found`);
          res.write('data: {"type":"error","message":"session_not_found"}\n\n');
          return res.end();
        }

        // Bind this HTTP session to the audio session
        await persistAudioSessionBinding(req, requestedSessionId);
      } else {
        // Fallback to existing session resolution
        session = await getSessionForRequest(req);
      }

      if (!session) {
        console.log('⚠️ Unable to create or locate session for SSE request');
        res.write('data: {"type":"error","message":"session_unavailable"}\n\n');
        return res.end();
      }

      console.log(`📡 SSE connected to session: ${session.sessionId}`);
      res.write('data: {"type":"connected","sessionId":"' + session.sessionId + '"}\n\n');

      // Rest of existing SSE setup...
      session.mixer.addEventClient(res);

      if (session.mixer.currentTrack && session.mixer.isActive) {
        session.mixer.broadcastTrackEvent(true);
      }

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

  3.2 Update /stream endpoint to accept session parameter

  app.get('/stream', async (req, res) => {
    console.log(`🔥 Stream request received`);

    try {
      const requestedSessionId = req.query.session;
      let session;

      if (requestedSessionId) {
        console.log(`🎵 Stream requesting specific session: ${requestedSessionId}`);
        session = getSessionById(requestedSessionId);

        if (!session) {
          console.error(`🎵 Requested session ${requestedSessionId} not found`);
          return res.status(404).json({ error: 'Session not found' });
        }

        await persistAudioSessionBinding(req, requestedSessionId);
      } else {
        // Fallback to existing session resolution
        session = await getSessionForRequest(req);
      }

      if (!session) {
        console.log('⚠️ No session available for stream request');
        return res.status(404).json({ error: 'Session not found' });
      }

      console.log(`🎵 Audio streaming from session: ${session.sessionId}`);

      if (req.method === 'HEAD') {
        return res.end();
      }

      session.mixer.addClient(res);
    } catch (error) {
      console.error('Stream connection error:', error);
      res.status(500).json({ error: 'Failed to attach to stream' });
    }
  });

  ---
  Phase 4: Testing & Verification

  4.1 Test session establishment

  1. Clear localStorage and cookies
  2. Load page
  3. Check console for: 🔧 Created new session: session_XXXXXX
  4. Verify same session ID appears in both SSE and audio logs

  4.2 Test session persistence

  1. Refresh page
  2. Check console for: 🔧 Found cached session: session_XXXXXX
  3. Verify same session ID is reused

  4.3 Test health monitoring

  1. Play audio
  2. Verify timeupdate events update health
  3. Simulate network issue (throttle in DevTools)
  4. Verify buffering detection after 8s
  5. Verify dead session detection after 12s

  4.4 Test recovery scenarios

  SSE dies:
  1. Kill SSE connection (close in DevTools)
  2. Verify: Audio keeps playing
  3. Verify: SSE reconnects to same session

  Audio dies:
  1. Kill audio connection
  2. Verify: Full app restart (page reload)
  3. Verify: New session created

  4.5 Verify no split sessions

  1. Open DevTools Network tab
  2. Start playback
  3. Verify /stream and /events use same session ID
  4. Check server logs: should only see ONE session created

  ---
  Success Criteria

  ✅ Single session ID used for both audio and SSE✅ Session established before any connections✅ Audio timeupdate is
  primary health signal✅ SSE reconnects to audio's session if it fails✅ Audio failure triggers full restart✅ Session
  persists across page refreshes✅ No "split brain" scenarios in logs

  Files to Modify

  1. public/scripts/page.js - Session bootstrap, health monitoring, connection logic
  2. server.js - SSE and stream endpoints to accept session parameter

  Rollback Plan

  If issues occur:
  1. Revert server.js changes (restore session resolution via cookie only)
  2. Revert page.js changes (restore automatic session creation)
  3. Clear localStorage: localStorage.removeItem('audioSessionId')
