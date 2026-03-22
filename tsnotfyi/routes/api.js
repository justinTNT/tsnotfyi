// User data and analysis API endpoints
// Extracted from server.js for readability

function setupApiRoutes(app, { db, apiClient }) {

  // ==================== TRACK RATING/COMPLETION ====================

  // Rate a track (love/hate)
  app.post('/api/track/:id/rate', async (req, res) => {
    const { id } = req.params;
    const { rating } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'Missing track identifier' });
    }

    if (rating === undefined || ![-1, 0, 1].includes(rating)) {
      return res.status(400).json({ error: 'Rating must be -1 (hate), 0 (neutral), or 1 (love)' });
    }

    try {
      const result = await db.upsertRating(id, rating);
      if (!result) {
        return res.status(404).json({ error: 'Track not found' });
      }
      // Update API server's in-memory KD-tree
      try {
        await apiClient._post('/internal/track-loved', { identifier: id, loved: rating === 1 });
      } catch (e) {
        console.warn('Failed to update API server loved state:', e.message);
      }
      res.json(result);
    } catch (error) {
      console.error('Error updating track rating:', error);
      res.status(500).json({ error: 'Failed to update rating' });
    }
  });

  // Mark track as completed (successful crossfade)
  app.post('/api/track/:id/complete', async (req, res) => {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'Missing track identifier' });
    }

    try {
      const result = await db.recordCompletionChecked(id);
      if (!result) {
        return res.status(404).json({ error: 'Track not found' });
      }
      res.json(result);
    } catch (error) {
      console.error('Error recording track completion:', error);
      res.status(500).json({ error: 'Failed to record completion' });
    }
  });

  // Get track stats (ratings, completions)
  app.get('/api/track/:id/stats', async (req, res) => {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: 'Missing track identifier' });
    }

    try {
      const stats = await db.getRatingWithStats(id);
      res.json(stats);
    } catch (error) {
      console.error('Error getting track stats:', error);
      res.status(500).json({ error: 'Failed to get track stats' });
    }
  });

  // ==================== PLAYLISTS ====================

  app.post('/api/playlists', async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Playlist name is required' });
    try {
      const result = await db.createPlaylist(name, description);
      res.json(result);
    } catch (error) {
      console.error('Error creating playlist:', error);
      res.status(500).json({ error: 'Failed to create playlist' });
    }
  });

  app.get('/api/playlists', async (req, res) => {
    try {
      const playlists = await db.getPlaylists();
      res.json(playlists);
    } catch (error) {
      console.error('Error listing playlists:', error);
      res.status(500).json({ error: 'Failed to list playlists' });
    }
  });

  app.get('/api/playlists/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const playlist = await db.getPlaylistWithTracks(id);
      if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
      res.json(playlist);
    } catch (error) {
      console.error('Error getting playlist:', error);
      res.status(500).json({ error: 'Failed to get playlist' });
    }
  });

  app.post('/api/playlists/:id/tracks', async (req, res) => {
    const { id } = req.params;
    const { identifier, direction, scope, position } = req.body;
    if (!identifier) return res.status(400).json({ error: 'Track identifier is required' });
    try {
      const result = await db.addToPlaylist(id, identifier, direction, scope, position);
      if (!result) return res.status(404).json({ error: 'Playlist not found' });
      res.json(result);
    } catch (error) {
      console.error('Error adding track to playlist:', error);
      res.status(500).json({ error: 'Failed to add track to playlist' });
    }
  });

  // ==================== PLAYLIST TREE ====================

  app.get('/api/playlist-tree', async (req, res) => {
    try {
      const tree = await db.getPlaylistTree();
      res.json(tree);
    } catch (error) {
      console.error('Error getting playlist tree:', error);
      res.status(500).json({ error: 'Failed to get playlist tree' });
    }
  });

  // ==================== FOLDERS ====================

  app.post('/api/folders', async (req, res) => {
    const { name, parent_id, position } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    try {
      const result = await db.createFolder(name, parent_id, position);
      res.json(result);
    } catch (error) {
      console.error('Error creating folder:', error);
      res.status(500).json({ error: 'Failed to create folder' });
    }
  });

  app.patch('/api/folders/:id', async (req, res) => {
    const { id } = req.params;
    const { name, parent_id, position } = req.body;
    try {
      const result = await db.updateFolder(id, { name, parent_id, position });
      if (!result) return res.status(404).json({ error: 'Folder not found' });
      if (result.error === 'nothing_to_update') return res.status(400).json({ error: 'Nothing to update' });
      res.json(result);
    } catch (error) {
      console.error('Error updating folder:', error);
      res.status(500).json({ error: 'Failed to update folder' });
    }
  });

  app.delete('/api/folders/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const deleted = await db.deleteFolder(id);
      if (!deleted) return res.status(404).json({ error: 'Folder not found' });
      res.json({ deleted: true });
    } catch (error) {
      console.error('Error deleting folder:', error);
      res.status(500).json({ error: 'Failed to delete folder' });
    }
  });

  // ==================== PLAYLIST MANAGEMENT ====================

  app.patch('/api/playlists/:id', async (req, res) => {
    const { id } = req.params;
    const { name, folder_id, position, description } = req.body;
    try {
      const result = await db.updatePlaylist(id, { name, folder_id, position, description });
      if (!result) return res.status(404).json({ error: 'Playlist not found' });
      if (result.error === 'nothing_to_update') return res.status(400).json({ error: 'Nothing to update' });
      res.json(result);
    } catch (error) {
      console.error('Error updating playlist:', error);
      res.status(500).json({ error: 'Failed to update playlist' });
    }
  });

  app.delete('/api/playlists/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const deleted = await db.deletePlaylist(id);
      if (!deleted) return res.status(404).json({ error: 'Playlist not found' });
      res.json({ deleted: true });
    } catch (error) {
      console.error('Error deleting playlist:', error);
      res.status(500).json({ error: 'Failed to delete playlist' });
    }
  });

  app.post('/api/reorder', async (req, res) => {
    const { folders, playlists } = req.body;
    try {
      await db.reorderItems(folders, playlists);
      res.json({ ok: true });
    } catch (error) {
      console.error('Error reordering:', error);
      res.status(500).json({ error: 'Failed to reorder' });
    }
  });

  // ==================== FOLDER TRACKS ====================

  app.get('/api/folder-tracks/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await db.getFolderTracks(id);
      if (!result) return res.status(404).json({ error: 'Track not found' });

      // Enrich with metadata from API server
      let folderCover = null;
      for (const track of result.tracks) {
        try {
          const kdTrack = await apiClient.getTrack(track.identifier);
          if (kdTrack) {
            track.albumCover = kdTrack.albumCover || null;
            track.loved = kdTrack.loved || false;
            track.hated = false;
            track.duration = kdTrack.length || null;
            if (!folderCover && track.albumCover) folderCover = track.albumCover;
          } else {
            const stats = await db.getRatingWithStats(track.identifier);
            track.hated = stats?.rating === -1;
            track.loved = stats?.rating === 1;
            track.albumCover = null;
            track.duration = null;
          }
        } catch (e) {
          const stats = await db.getRatingWithStats(track.identifier);
          track.hated = stats?.rating === -1;
          track.loved = stats?.rating === 1;
          track.albumCover = null;
          track.duration = null;
        }
      }
      if (folderCover) {
        for (const track of result.tracks) {
          if (!track.albumCover) track.albumCover = folderCover;
        }
      }

      res.json(result);
    } catch (error) {
      console.error('Error getting folder tracks:', error);
      res.status(500).json({ error: 'Failed to get folder tracks' });
    }
  });

  // ==================== DIMENSION ANALYSIS ====================

  app.get('/api/dimensions/stats', async (req, res) => {
    try {
      const stats = await db.getDimensionStats();
      res.json(stats);
    } catch (error) {
      console.error('Error getting dimension stats:', error);
      res.status(500).json({ error: 'Failed to get dimension stats' });
    }
  });

  app.get('/api/dimensions/track/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const track = await db.getTrackDimensions(id);
      if (!track) return res.status(404).json({ error: 'Track not found' });
      res.json(track);
    } catch (error) {
      console.error('Error getting track dimensions:', error);
      res.status(500).json({ error: 'Failed to get track dimensions' });
    }
  });

  // KD-tree search endpoints are served by the API server (port 3003)
}

module.exports = { setupApiRoutes };
