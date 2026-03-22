// Playlist routes and transformation functions
// Extracted from server.js for readability

const path = require('path');

// Reverse direction name helper
function reverseDirectionName(directionName) {
  if (!directionName) return null;

  if (directionName.includes('_positive')) {
    return directionName.replace('_positive', '_negative');
  }
  if (directionName.includes('_negative')) {
    return directionName.replace('_negative', '_positive');
  }

  const reverseMap = {
    'faster': 'slower', 'slower': 'faster',
    'brighter': 'darker', 'darker': 'brighter',
    'more_energetic': 'calmer', 'calmer': 'more_energetic',
    'more_danceable': 'less_danceable', 'less_danceable': 'more_danceable',
    'more_tonal': 'more_atonal', 'more_atonal': 'more_tonal',
    'more_complex': 'simpler', 'simpler': 'more_complex',
    'more_punchy': 'smoother', 'smoother': 'more_punchy'
  };

  return reverseMap[directionName] || directionName;
}

// ==================== PLAYLIST TRANSFORMATION FUNCTIONS ====================

async function generateSimilarPlaylist(originalTracks) {
  return originalTracks.map(track => ({
    identifier: track.identifier,
    direction: track.direction,
    scope: track.scope || 'magnify'
  }));
}

function generateReversePlaylist(originalTracks) {
  const reversedTracks = [...originalTracks].reverse();
  return reversedTracks.map((track, i) => ({
    identifier: track.identifier,
    direction: i === 0 ? null : reverseDirectionName(track.direction),
    scope: track.scope || 'magnify'
  }));
}

async function generateReverseSimilarPlaylist(originalTracks) {
  const reverseStack = generateReversePlaylist(originalTracks);
  return await generateSimilarPlaylist(reverseStack);
}

async function generateScaledPlaylist(originalTracks, scaleFactor) {
  if (scaleFactor === 1.0) {
    return originalTracks.map(track => ({
      identifier: track.identifier,
      direction: track.direction,
      scope: track.scope || 'magnify'
    }));
  }

  const scaledStack = [];

  if (scaleFactor > 1.0) {
    for (let i = 0; i < originalTracks.length; i++) {
      const track = originalTracks[i];
      scaledStack.push({ identifier: track.identifier, direction: track.direction, scope: track.scope || 'magnify' });

      if (i < originalTracks.length - 1) {
        const intermediateCount = Math.floor(scaleFactor) - 1;
        for (let j = 0; j < intermediateCount; j++) {
          scaledStack.push({ identifier: track.identifier, direction: track.direction, scope: track.scope || 'magnify' });
        }
      }
    }
  } else {
    const skipRate = Math.ceil(1 / scaleFactor);
    for (let i = 0; i < originalTracks.length; i += skipRate) {
      const track = originalTracks[i];
      scaledStack.push({ identifier: track.identifier, direction: track.direction, scope: track.scope || 'magnify' });
    }
  }

  console.log(`🔄 Generated ${scaleFactor}x scaled playlist: ${originalTracks.length} → ${scaledStack.length} tracks`);
  return scaledStack;
}

// ==================== ROUTE SETUP ====================

function setupPlaylistRoutes(app, { db, createSession, getSessionById, registerSession, audioClient }) {

  // Playlist session: /playlist/title
  app.get('/playlist/:title', async (req, res) => {
    const { title } = req.params;
    const playlistTitle = decodeURIComponent(title);

    try {
      const playlistData = await db.getPlaylistByName(playlistTitle);
      if (!playlistData) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      const sessionId = `playlist_${playlistTitle}`;
      let session = getSessionById(sessionId);

      if (!session) {
        session = await createSession({ sessionId, sessionType: 'playlist', sessionName: playlistTitle });

        const playlistStack = playlistData.tracks.map(track => ({
          identifier: track.identifier, direction: track.direction, scope: track.scope || 'magnify'
        }));

        await audioClient.initializeSession(sessionId, 'playlist', playlistTitle, playlistStack);
        console.log(`📚 Loaded playlist: ${playlistTitle} (${playlistStack.length} tracks)`);

        registerSession(sessionId, session);
      } else {
        console.log(`📚 Resuming existing playlist session: ${sessionId}`);
      }

      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error loading playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Playlist session with position navigation
  app.get('/playlist/:title/:stackIndex/:positionSeconds', async (req, res) => {
    const { title, stackIndex, positionSeconds } = req.params;
    const playlistTitle = decodeURIComponent(title);

    const index = parseInt(stackIndex);
    const position = parseInt(positionSeconds);
    if (isNaN(index) || isNaN(position) || index < 0 || position < 0) {
      return res.status(400).json({ error: 'Invalid stack index or position' });
    }

    try {
      const sessionId = `playlist_${playlistTitle}`;
      let session = getSessionById(sessionId);

      if (!session) {
        const playlistData = await db.getPlaylistByName(playlistTitle);
        if (!playlistData) return res.status(404).json({ error: 'Playlist not found' });

        session = await createSession({ sessionId, sessionType: 'playlist', sessionName: playlistTitle });

        const playlistStack = playlistData.tracks.map(track => ({
          identifier: track.identifier, direction: track.direction, scope: track.scope || 'magnify'
        }));

        await audioClient.initializeSession(sessionId, 'playlist', playlistTitle, playlistStack);
        registerSession(sessionId, session);
      }

      await audioClient.jumpToStackPosition(sessionId, index, position);

      console.log(`🎯 Playlist ${playlistTitle} jumped to position ${index}/${position}`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error navigating playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Playlist session with stack index
  app.get('/playlist/:title/:stackIndex', async (req, res) => {
    const { title, stackIndex } = req.params;
    const playlistTitle = decodeURIComponent(title);

    const index = parseInt(stackIndex);
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid stack index' });
    }

    try {
      const sessionId = `playlist_${playlistTitle}`;
      let session = getSessionById(sessionId);

      if (!session) {
        const playlistData = await db.getPlaylistByName(playlistTitle);
        if (!playlistData) return res.status(404).json({ error: 'Playlist not found' });

        session = await createSession({ sessionId, sessionType: 'playlist', sessionName: playlistTitle });

        const playlistStack = playlistData.tracks.map(track => ({
          identifier: track.identifier, direction: track.direction, scope: track.scope || 'magnify'
        }));

        await audioClient.initializeSession(sessionId, 'playlist', playlistTitle, playlistStack);
        registerSession(sessionId, session);
      }

      await audioClient.jumpToStackPosition(sessionId, index, 0);

      console.log(`🎯 Playlist ${playlistTitle} jumped to position ${index}`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error navigating playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== TRANSFORMATION ROUTES ====================

  async function createTransformSession(playlistTitle, prefix, labelPrefix, stack, createSession, registerSession) {
    const sessionId = `${prefix}_${playlistTitle}_${Date.now()}`;
    const session = await createSession({ sessionId, sessionType: 'playlist', sessionName: `${labelPrefix} ${playlistTitle}` });
    await audioClient.initializeSession(sessionId, 'playlist', sessionId, stack);
    registerSession(sessionId, session);
    return session;
  }

  app.get('/similar/:playlistName', async (req, res) => {
    const playlistTitle = decodeURIComponent(req.params.playlistName);
    try {
      const original = await db.getPlaylistByName(playlistTitle);
      if (!original) return res.status(404).json({ error: 'Original playlist not found' });
      const stack = await generateSimilarPlaylist(original.tracks);
      await createTransformSession(playlistTitle, 'similar', 'Similar to', stack, createSession, registerSession);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error generating similar playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/reverse/:playlistName', async (req, res) => {
    const playlistTitle = decodeURIComponent(req.params.playlistName);
    try {
      const original = await db.getPlaylistByName(playlistTitle);
      if (!original) return res.status(404).json({ error: 'Original playlist not found' });
      const stack = generateReversePlaylist(original.tracks);
      await createTransformSession(playlistTitle, 'reverse', 'Reverse of', stack, createSession, registerSession);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error generating reverse playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/reverse_similar/:playlistName', async (req, res) => {
    const playlistTitle = decodeURIComponent(req.params.playlistName);
    try {
      const original = await db.getPlaylistByName(playlistTitle);
      if (!original) return res.status(404).json({ error: 'Original playlist not found' });
      const stack = await generateReverseSimilarPlaylist(original.tracks);
      await createTransformSession(playlistTitle, 'reverse_similar', 'Reverse Similar to', stack, createSession, registerSession);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error generating reverse similar playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/scaled/:scale/:playlistName', async (req, res) => {
    const { scale } = req.params;
    const playlistTitle = decodeURIComponent(req.params.playlistName);

    const scaleMatch = scale.match(/^(\d+(?:\.\d+)?)x$/);
    if (!scaleMatch) return res.status(400).json({ error: 'Invalid scale format (use 2x, 0.5x, etc.)' });
    const scaleFactor = parseFloat(scaleMatch[1]);

    try {
      const original = await db.getPlaylistByName(playlistTitle);
      if (!original) return res.status(404).json({ error: 'Original playlist not found' });
      const stack = await generateScaledPlaylist(original.tracks, scaleFactor);
      await createTransformSession(playlistTitle, `scaled_${scale}`, `${scale}`, stack, createSession, registerSession);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error generating scaled playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { setupPlaylistRoutes };
