// Named session routes
// Lifecycle: /name creates or resumes, auto-saves on disconnect, /name/forget deletes

const path = require('path');

function isValidMD5(str) {
  return /^[a-f0-9]{32}$/.test(str);
}

const RESERVED_SESSION_PREFIXES = new Set([
  'api', 'sessions', 'playlist', 'playlists', 'stream', 'events', 'status',
  'search', 'track', 'vae', 'current-track', 'favicon.ico', 'health',
  'similar', 'reverse', 'reverse_similar', 'scaled', 'internal',
  'radial-search', 'directional-search', 'pca', 'explorer',
  'session', 'create-session', 'next-track', 'refresh-sse', 'refresh-sse-simple',
  'client-logs'
]);

function isReservedName(name) {
  return !name || RESERVED_SESSION_PREFIXES.has(name) || isValidMD5(name)
    || name.startsWith('playlist/') || name.includes('/');
}

function setupNamedSessionRoutes(app, { getSessionById, unregisterSession, registerSession, createSession, calculateStackDuration, db, audioClient }) {

  // /:sessionName/forget — delete named session from DB and memory
  app.get('/:sessionName/forget', async (req, res, next) => {
    const { sessionName } = req.params;
    if (isReservedName(sessionName)) return next();

    try {
      const session = getSessionById(sessionName);
      if (session) {
        try { await audioClient.destroySession(sessionName); } catch (e) { /* ignore */ }
        unregisterSession(sessionName);
        console.log(`🗑️ Unregistered named session: ${sessionName}`);
      }
      await db.deleteNamedSession(sessionName);
      console.log(`🗑️ Deleted named session from DB: ${sessionName}`);
      res.redirect('/');
    } catch (error) {
      console.error('Error deleting session:', error);
      res.status(500).json({ error: 'Failed to delete session' });
    }
  });

  // /:sessionName/reset — clear stack but keep session alive
  app.get('/:sessionName/reset', async (req, res, next) => {
    const { sessionName } = req.params;
    if (isReservedName(sessionName)) return next();

    try {
      const session = getSessionById(sessionName);
      if (session) {
        await audioClient.resetStack(sessionName);
        await audioClient.updateMetadata(sessionName, { ephemeral: false });
        console.log(`🔄 Reset named session: ${sessionName}`);
      }
      res.json({ message: `Session ${sessionName} reset` });
    } catch (error) {
      console.error('Error resetting session:', error);
      res.status(500).json({ error: 'Failed to reset session' });
    }
  });

  // /:sessionName/export — export session state as JSON
  app.get('/:sessionName/export', async (req, res, next) => {
    const { sessionName } = req.params;
    if (isReservedName(sessionName)) return next();

    try {
      const session = getSessionById(sessionName);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const stackState = await audioClient.getStackState(sessionName);
      res.json({
        ...stackState,
        shareUrl: `/${sessionName}`,
        trackCount: stackState.stack?.length || 0,
        duration: calculateStackDuration(stackState.stack || [])
      });
    } catch (error) {
      console.error('Error exporting session:', error);
      res.status(500).json({ error: 'Failed to export session' });
    }
  });

  // /:sessionName/save — explicitly save current state to DB
  app.get('/:sessionName/save', async (req, res, next) => {
    const { sessionName } = req.params;
    if (isReservedName(sessionName)) return next();

    try {
      const session = getSessionById(sessionName);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const state = await audioClient.getStackState(sessionName);
      await db.saveNamedSession(sessionName, state);
      console.log(`💾 Saved named session: ${sessionName}`);
      res.json({ message: `Session ${sessionName} saved` });
    } catch (error) {
      console.error('Error saving session:', error);
      res.status(500).json({ error: 'Failed to save session' });
    }
  });

  // /sessions/list — list all saved sessions
  app.get('/sessions/list', async (req, res) => {
    try {
      const sessions = await db.listNamedSessions();
      res.json({ sessions });
    } catch (error) {
      console.error('Error listing sessions:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // /:sessionName/name — rename current session
  app.post('/:sessionName/name', async (req, res, next) => {
    const { sessionName } = req.params;
    if (isReservedName(sessionName)) return next();

    const { currentSessionId } = req.body || {};
    if (!currentSessionId) {
      return res.status(400).json({ error: 'currentSessionId required' });
    }

    try {
      const session = getSessionById(currentSessionId);
      if (!session) {
        return res.status(404).json({ error: 'Current session not found' });
      }

      // Update mixer metadata on Audio server
      await audioClient.updateMetadata(currentSessionId, {
        sessionId: sessionName,
        sessionType: 'named',
        sessionName: sessionName
      });

      // Re-register under new name
      unregisterSession(currentSessionId);
      session.sessionId = sessionName;
      registerSession(sessionName, session);

      // Auto-save to DB
      const state = await audioClient.getStackState(sessionName);
      await db.saveNamedSession(sessionName, state);

      console.log(`📛 Renamed session ${currentSessionId} → ${sessionName}`);
      res.json({ sessionId: sessionName, message: `Session named: ${sessionName}` });
    } catch (error) {
      console.error('Error naming session:', error);
      res.status(500).json({ error: 'Failed to name session' });
    }
  });

  // /:sessionName/:stackIndex/:positionSeconds — jump to position
  app.get('/:sessionName/:stackIndex/:positionSeconds', async (req, res, next) => {
    const { sessionName, stackIndex, positionSeconds } = req.params;
    if (isReservedName(sessionName) || ['forget', 'reset', 'export', 'save', 'name'].includes(stackIndex)) {
      return next();
    }

    const index = parseInt(stackIndex);
    const position = parseInt(positionSeconds);
    if (isNaN(index) || isNaN(position) || index < 0 || position < 0) {
      return res.status(400).json({ error: 'Invalid stack index or position' });
    }

    try {
      const session = getSessionById(sessionName);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      await audioClient.jumpToStackPosition(sessionName, index, position);
      console.log(`🎯 Named session ${sessionName} jumped to position ${index}/${position}`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error navigating named session:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // /:sessionName/:stackIndex — jump to stack index
  app.get('/:sessionName/:stackIndex', async (req, res, next) => {
    const { sessionName, stackIndex } = req.params;
    if (isReservedName(sessionName) || ['forget', 'reset', 'export', 'save', 'name'].includes(stackIndex)) {
      return next();
    }

    const index = parseInt(stackIndex);
    if (isNaN(index) || index < 0) {
      return next();
    }

    try {
      const session = getSessionById(sessionName);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      await audioClient.jumpToStackPosition(sessionName, index, 0);
      console.log(`🎯 Named session ${sessionName} jumped to position ${index}`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error navigating named session:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // /:sessionName — create or resume named session
  app.get('/:sessionName', async (req, res, next) => {
    const { sessionName } = req.params;
    if (isReservedName(sessionName)) {
      return next();
    }

    try {
      let session = getSessionById(sessionName);

      if (!session) {
        session = await createSession({
          sessionId: sessionName,
          sessionType: 'named',
          sessionName: sessionName
        });

        // Try to restore from DB
        const savedState = await db.loadNamedSession(sessionName);
        if (savedState) {
          await audioClient.loadStackState(sessionName, savedState);
          console.log(`📚 Restored named session from DB: ${sessionName}`);
        } else {
          await audioClient.initializeSession(sessionName, 'named', sessionName);
          console.log(`🆕 Created new named session: ${sessionName}`);
        }

        registerSession(sessionName, session);

        // Set up auto-save on disconnect via callback URL
        const webUrl = `http://localhost:${app.get('port') || 3001}`;
        await audioClient.setOnIdle(sessionName, `${webUrl}/internal/session-idle/${sessionName}`);
      } else {
        console.log(`📚 Resuming existing named session: ${sessionName}`);
      }

      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error handling named session:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { setupNamedSessionRoutes, isValidMD5, RESERVED_SESSION_PREFIXES };
