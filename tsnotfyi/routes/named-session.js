// Named session routes
// Extracted from server.js for readability

const path = require('path');

// Validate MD5 format (32-character hex string)
function isValidMD5(str) {
  return /^[a-f0-9]{32}$/.test(str);
}

// Save named session state to database (placeholder)
async function saveNamedSessionToDatabase(session) {
  // For now, ensure it's persisted in memory registry
  session.mixer.persistSessionState();
  console.log(`💾 Saved session ${session.mixer.sessionName} to memory registry`);
}

// Load named session state from database (placeholder)
async function loadNamedSessionFromDatabase(sessionName) {
  // Load from memory registry
  global.namedSessionRegistry = global.namedSessionRegistry || new Map();
  const savedState = global.namedSessionRegistry.get(sessionName);

  if (savedState) {
    console.log(`📖 Loaded session ${sessionName} from memory registry`);
    return savedState;
  }

  console.log(`📖 No saved state found for session ${sessionName}`);
  return null;
}

const RESERVED_SESSION_PREFIXES = new Set([
  'api', 'sessions', 'playlist', 'stream', 'events', 'status',
  'search', 'track', 'vae', 'current-track', 'favicon.ico', 'health',
  'similar', 'reverse', 'reverse_similar', 'scaled'
]);

function setupNamedSessionRoutes(app, { getSessionById, unregisterSession, registerSession, createSession, calculateStackDuration }) {

  // /:sessionName/forget - Delete named session
  app.get('/:sessionName/forget', async (req, res) => {
    const { sessionName } = req.params;

    if (isValidMD5(sessionName) || sessionName.startsWith('playlist/')) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    try {
      const session = getSessionById(sessionName);
      if (session) {
        await saveNamedSessionToDatabase(session);
        unregisterSession(sessionName);
        console.log(`🗑️ Deleted named session: ${sessionName}`);
      }

      res.json({ message: `Session ${sessionName} deleted` });
    } catch (error) {
      console.error('Error deleting session:', error);
      res.status(500).json({ error: 'Failed to delete session' });
    }
  });

  // /:sessionName/reset - Reset named session stack
  app.get('/:sessionName/reset', async (req, res) => {
    const { sessionName } = req.params;

    if (isValidMD5(sessionName) || sessionName.startsWith('playlist/')) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    try {
      const session = getSessionById(sessionName);
      if (session) {
        session.mixer.resetStack();
        session.mixer.ephemeral = false;
        console.log(`🔄 Reset named session: ${sessionName}`);
      }

      res.json({ message: `Session ${sessionName} reset` });
    } catch (error) {
      console.error('Error resetting session:', error);
      res.status(500).json({ error: 'Failed to reset session' });
    }
  });

  // /:sessionName/export - Export session state
  app.get('/:sessionName/export', async (req, res) => {
    const { sessionName } = req.params;

    if (isValidMD5(sessionName) || sessionName.startsWith('playlist/')) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    try {
      const session = getSessionById(sessionName);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const stackState = session.mixer.getStackState();
      const exportData = {
        ...stackState,
        shareUrl: `/${sessionName}`,
        trackCount: stackState.stack.length,
        duration: calculateStackDuration(stackState.stack)
      };

      res.json(exportData);
    } catch (error) {
      console.error('Error exporting session:', error);
      res.status(500).json({ error: 'Failed to export session' });
    }
  });

  // /:sessionName/:stackIndex/:positionSeconds - Jump to position
  app.get('/:sessionName/:stackIndex/:positionSeconds', async (req, res, next) => {
    const { sessionName, stackIndex, positionSeconds } = req.params;

    if (isValidMD5(sessionName) || sessionName.startsWith('playlist/') ||
        RESERVED_SESSION_PREFIXES.has(sessionName) ||
        ['forget', 'reset', 'export'].includes(stackIndex)) {
      if (RESERVED_SESSION_PREFIXES.has(sessionName)) {
        return next();
      }
      return res.status(404).json({ error: 'Route not found' });
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

      await session.mixer.jumpToStackPosition(index, position);

      console.log(`🎯 Named session ${sessionName} jumped to position ${index}/${position}`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error navigating named session:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // /:sessionName/:stackIndex - Jump to stack index
  app.get('/:sessionName/:stackIndex', async (req, res, next) => {
    const { sessionName, stackIndex } = req.params;

    if (isValidMD5(sessionName) || sessionName.startsWith('playlist/') ||
        RESERVED_SESSION_PREFIXES.has(sessionName) ||
        ['forget', 'reset', 'export'].includes(stackIndex)) {
      if (RESERVED_SESSION_PREFIXES.has(sessionName)) {
        return next();
      }
      return res.status(404).json({ error: 'Route not found' });
    }

    const index = parseInt(stackIndex);
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid stack index' });
    }

    try {
      const session = getSessionById(sessionName);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      await session.mixer.jumpToStackPosition(index, 0);

      console.log(`🎯 Named session ${sessionName} jumped to position ${index}`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error navigating named session:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // /:sessionName - Basic named session
  app.get('/:sessionName', async (req, res, next) => {
    const { sessionName } = req.params;

    if (isValidMD5(sessionName) || sessionName.startsWith('playlist/') ||
        sessionName.includes('/') || RESERVED_SESSION_PREFIXES.has(sessionName)) {
      if (RESERVED_SESSION_PREFIXES.has(sessionName)) {
        return next();
      }
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

        const savedState = await loadNamedSessionFromDatabase(sessionName);
        if (savedState) {
          session.mixer.loadStackState(savedState);
          console.log(`📚 Loaded saved named session: ${sessionName}`);
        } else {
          session.mixer.initializeSession('named', sessionName);
          console.log(`🆕 Created new named session: ${sessionName}`);
        }

        registerSession(sessionName, session);
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
