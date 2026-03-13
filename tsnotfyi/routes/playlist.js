// Playlist routes and transformation functions
// Extracted from server.js for readability

const path = require('path');

// Load playlist from database
async function loadPlaylistFromDatabase(pool, playlistTitle) {
  try {
    const client = await pool.connect();

    try {
      // Get playlist info
      const playlistResult = await client.query(
        'SELECT * FROM playlists WHERE name = $1',
        [playlistTitle]
      );

      if (playlistResult.rows.length === 0) {
        return null; // Playlist not found
      }

      // Get playlist tracks
      const tracksResult = await client.query(`
        SELECT
          pi.identifier,
          pi.direction,
          pi.scope,
          pi.position
        FROM playlist_items pi
        WHERE pi.playlist_id = $1
        ORDER BY pi.position ASC
      `, [playlistResult.rows[0].id]);

      const playlist = playlistResult.rows[0];
      playlist.tracks = tracksResult.rows;

      console.log(`📖 Loaded playlist ${playlistTitle}: ${playlist.tracks.length} tracks`);
      return playlist;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error loading playlist from database:', error);
    throw error;
  }
}

// Reverse direction name helper
function reverseDirectionName(directionName) {
  if (!directionName) return null;

  // Handle PCA directions
  if (directionName.includes('_positive')) {
    return directionName.replace('_positive', '_negative');
  }
  if (directionName.includes('_negative')) {
    return directionName.replace('_negative', '_positive');
  }

  // Handle semantic directions
  const reverseMap = {
    'faster': 'slower',
    'slower': 'faster',
    'brighter': 'darker',
    'darker': 'brighter',
    'more_energetic': 'calmer',
    'calmer': 'more_energetic',
    'more_danceable': 'less_danceable',
    'less_danceable': 'more_danceable',
    'more_tonal': 'more_atonal',
    'more_atonal': 'more_tonal',
    'more_complex': 'simpler',
    'simpler': 'more_complex',
    'more_punchy': 'smoother',
    'smoother': 'more_punchy'
  };

  return reverseMap[directionName] || directionName;
}

// ==================== PLAYLIST TRANSFORMATION FUNCTIONS ====================

// Generate similar playlist (different tracks, same directions)
async function generateSimilarPlaylist(originalTracks) {
  const similarStack = [];

  for (const track of originalTracks) {
    // TODO: Implement actual similarity search
    // For now, just return the same tracks (placeholder)
    similarStack.push({
      identifier: track.identifier, // Would be replaced with similar track
      direction: track.direction,
      scope: track.scope || 'magnify'
    });
  }

  console.log(`🔄 Generated similar playlist: ${similarStack.length} tracks (placeholder)`);
  return similarStack;
}

// Generate reverse playlist (same tracks, opposite directions)
function generateReversePlaylist(originalTracks) {
  const reverseStack = [];

  // Reverse the track order
  const reversedTracks = [...originalTracks].reverse();

  for (let i = 0; i < reversedTracks.length; i++) {
    const track = reversedTracks[i];
    let reverseDirection = null;

    if (track.direction) {
      // Reverse the direction
      reverseDirection = reverseDirectionName(track.direction);
    }

    reverseStack.push({
      identifier: track.identifier,
      direction: i === 0 ? null : reverseDirection, // First track has no direction
      scope: track.scope || 'magnify'
    });
  }

  console.log(`🔄 Generated reverse playlist: ${reverseStack.length} tracks`);
  return reverseStack;
}

// Generate reverse similar playlist (different tracks, opposite directions)
async function generateReverseSimilarPlaylist(originalTracks) {
  // First generate reverse, then make similar
  const reverseStack = generateReversePlaylist(originalTracks);
  return await generateSimilarPlaylist(reverseStack);
}

// Generate scaled playlist (same pattern, different density)
async function generateScaledPlaylist(originalTracks, scaleFactor) {
  if (scaleFactor === 1.0) {
    // No scaling needed
    return originalTracks.map(track => ({
      identifier: track.identifier,
      direction: track.direction,
      scope: track.scope || 'magnify'
    }));
  }

  const scaledStack = [];

  if (scaleFactor > 1.0) {
    // Scale up: Add intermediate tracks between existing ones
    for (let i = 0; i < originalTracks.length; i++) {
      const track = originalTracks[i];

      // Add original track
      scaledStack.push({
        identifier: track.identifier,
        direction: track.direction,
        scope: track.scope || 'magnify'
      });

      // Add intermediate tracks (except after last track)
      if (i < originalTracks.length - 1) {
        const intermediateCount = Math.floor(scaleFactor) - 1;
        for (let j = 0; j < intermediateCount; j++) {
          // TODO: Generate intermediate tracks with similar characteristics
          // For now, just duplicate the track (placeholder)
          scaledStack.push({
            identifier: track.identifier, // Would be similar track
            direction: track.direction,
            scope: track.scope || 'magnify'
          });
        }
      }
    }
  } else {
    // Scale down: Skip tracks to compress the journey
    const skipRate = Math.ceil(1 / scaleFactor);
    for (let i = 0; i < originalTracks.length; i += skipRate) {
      const track = originalTracks[i];
      scaledStack.push({
        identifier: track.identifier,
        direction: track.direction,
        scope: track.scope || 'magnify'
      });
    }
  }

  console.log(`🔄 Generated ${scaleFactor}x scaled playlist: ${originalTracks.length} → ${scaledStack.length} tracks`);
  return scaledStack;
}

// ==================== ROUTE SETUP ====================

function setupPlaylistRoutes(app, { pool, createSession, getSessionById, registerSession }) {

  // Playlist session: /playlist/title
  app.get('/playlist/:title', async (req, res) => {
    const { title } = req.params;
    const playlistTitle = decodeURIComponent(title);

    try {
      const playlistData = await loadPlaylistFromDatabase(pool, playlistTitle);
      if (!playlistData) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      const sessionId = `playlist_${playlistTitle}`;
      let session = getSessionById(sessionId);

      if (!session) {
        console.log(`Creating new playlist session: ${sessionId}`);
        session = await createSession({
          sessionId,
          sessionType: 'playlist',
          sessionName: playlistTitle
        });

        const playlistStack = playlistData.tracks.map(track => ({
          identifier: track.identifier,
          direction: track.direction,
          scope: track.scope || 'magnify'
        }));

        session.mixer.initializeSession('playlist', playlistTitle, playlistStack);
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

  // Playlist session with position navigation: /playlist/title/4/20
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
        const playlistData = await loadPlaylistFromDatabase(pool, playlistTitle);
        if (!playlistData) {
          return res.status(404).json({ error: 'Playlist not found' });
        }

        session = await createSession({
          sessionId,
          sessionType: 'playlist',
          sessionName: playlistTitle
        });

        const playlistStack = playlistData.tracks.map(track => ({
          identifier: track.identifier,
          direction: track.direction,
          scope: track.scope || 'magnify'
        }));

        session.mixer.initializeSession('playlist', playlistTitle, playlistStack);
        registerSession(sessionId, session);
      }

      await session.mixer.jumpToStackPosition(index, position);

      console.log(`🎯 Playlist ${playlistTitle} jumped to position ${index}/${position}`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error navigating playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Playlist session with stack index: /playlist/title/4
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
        const playlistData = await loadPlaylistFromDatabase(pool, playlistTitle);
        if (!playlistData) {
          return res.status(404).json({ error: 'Playlist not found' });
        }

        session = await createSession({
          sessionId,
          sessionType: 'playlist',
          sessionName: playlistTitle
        });

        const playlistStack = playlistData.tracks.map(track => ({
          identifier: track.identifier,
          direction: track.direction,
          scope: track.scope || 'magnify'
        }));

        session.mixer.initializeSession('playlist', playlistTitle, playlistStack);
        registerSession(sessionId, session);
      }

      await session.mixer.jumpToStackPosition(index, 0);

      console.log(`🎯 Playlist ${playlistTitle} jumped to position ${index}`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error navigating playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // ==================== TRANSFORMATION ROUTES ====================

  // Similar playlist: /similar/playlist_name
  app.get('/similar/:playlistName', async (req, res) => {
    const { playlistName } = req.params;
    const playlistTitle = decodeURIComponent(playlistName);

    try {
      const originalPlaylist = await loadPlaylistFromDatabase(pool, playlistTitle);
      if (!originalPlaylist) {
        return res.status(404).json({ error: 'Original playlist not found' });
      }

      const similarStack = await generateSimilarPlaylist(originalPlaylist.tracks);

      const sessionId = `similar_${playlistTitle}_${Date.now()}`;
      const session = await createSession({
        sessionId,
        sessionType: 'playlist',
        sessionName: `Similar to ${playlistTitle}`
      });

      session.mixer.initializeSession('playlist', sessionId, similarStack);
      registerSession(sessionId, session);

      console.log(`📚 Generated similar playlist: ${similarStack.length} tracks`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error generating similar playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Reverse playlist: /reverse/playlist_name
  app.get('/reverse/:playlistName', async (req, res) => {
    const { playlistName } = req.params;
    const playlistTitle = decodeURIComponent(playlistName);

    try {
      const originalPlaylist = await loadPlaylistFromDatabase(pool, playlistTitle);
      if (!originalPlaylist) {
        return res.status(404).json({ error: 'Original playlist not found' });
      }

      const reverseStack = generateReversePlaylist(originalPlaylist.tracks);

      const sessionId = `reverse_${playlistTitle}_${Date.now()}`;
      const session = await createSession({
        sessionId,
        sessionType: 'playlist',
        sessionName: `Reverse of ${playlistTitle}`
      });

      session.mixer.initializeSession('playlist', sessionId, reverseStack);
      registerSession(sessionId, session);

      console.log(`📚 Generated reverse playlist: ${reverseStack.length} tracks`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error generating reverse playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Reverse similar playlist: /reverse_similar/playlist_name
  app.get('/reverse_similar/:playlistName', async (req, res) => {
    const { playlistName } = req.params;
    const playlistTitle = decodeURIComponent(playlistName);

    try {
      const originalPlaylist = await loadPlaylistFromDatabase(pool, playlistTitle);
      if (!originalPlaylist) {
        return res.status(404).json({ error: 'Original playlist not found' });
      }

      const reverseSimilarStack = await generateReverseSimilarPlaylist(originalPlaylist.tracks);

      const sessionId = `reverse_similar_${playlistTitle}_${Date.now()}`;
      const session = await createSession({
        sessionId,
        sessionType: 'playlist',
        sessionName: `Reverse Similar to ${playlistTitle}`
      });

      session.mixer.initializeSession('playlist', sessionId, reverseSimilarStack);
      registerSession(sessionId, session);

      console.log(`📚 Generated reverse similar playlist: ${reverseSimilarStack.length} tracks`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error generating reverse similar playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Scaled playlist: /scaled/2x/playlist_name
  app.get('/scaled/:scale/:playlistName', async (req, res) => {
    const { scale, playlistName } = req.params;
    const playlistTitle = decodeURIComponent(playlistName);

    const scaleMatch = scale.match(/^(\d+(?:\.\d+)?)x$/);
    if (!scaleMatch) {
      return res.status(400).json({ error: 'Invalid scale format (use 2x, 0.5x, etc.)' });
    }
    const scaleFactor = parseFloat(scaleMatch[1]);

    try {
      const originalPlaylist = await loadPlaylistFromDatabase(pool, playlistTitle);
      if (!originalPlaylist) {
        return res.status(404).json({ error: 'Original playlist not found' });
      }

      const scaledStack = await generateScaledPlaylist(originalPlaylist.tracks, scaleFactor);

      const sessionId = `scaled_${scale}_${playlistTitle}_${Date.now()}`;
      const session = await createSession({
        sessionId,
        sessionType: 'playlist',
        sessionName: `${scale} ${playlistTitle}`
      });

      session.mixer.initializeSession('playlist', sessionId, scaledStack);
      registerSession(sessionId, session);

      console.log(`📚 Generated ${scale} scaled playlist: ${scaledStack.length} tracks`);
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } catch (error) {
      console.error('Error generating scaled playlist:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { setupPlaylistRoutes };
