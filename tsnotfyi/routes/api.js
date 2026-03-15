// User data and analysis API endpoints
// Extracted from server.js for readability

function setupApiRoutes(app, { db, radialSearch }) {

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

  // Create playlist
  app.post('/api/playlists', async (req, res) => {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    try {
      const result = await db.createPlaylist(name, description);
      res.json(result);
    } catch (error) {
      console.error('Error creating playlist:', error);
      res.status(500).json({ error: 'Failed to create playlist' });
    }
  });

  // List playlists
  app.get('/api/playlists', async (req, res) => {
    try {
      const playlists = await db.getPlaylists();
      res.json(playlists);
    } catch (error) {
      console.error('Error listing playlists:', error);
      res.status(500).json({ error: 'Failed to list playlists' });
    }
  });

  // Get playlist with tracks
  app.get('/api/playlists/:id', async (req, res) => {
    const { id } = req.params;

    try {
      const playlist = await db.getPlaylistWithTracks(id);
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }
      res.json(playlist);
    } catch (error) {
      console.error('Error getting playlist:', error);
      res.status(500).json({ error: 'Failed to get playlist' });
    }
  });

  // Add track to playlist
  app.post('/api/playlists/:id/tracks', async (req, res) => {
    const { id } = req.params;
    const { identifier, direction, scope, position } = req.body;

    if (!identifier) {
      return res.status(400).json({ error: 'Track identifier is required' });
    }

    try {
      const result = await db.addToPlaylist(id, identifier, direction, scope, position);
      if (!result) {
        return res.status(404).json({ error: 'Playlist not found' });
      }
      res.json(result);
    } catch (error) {
      console.error('Error adding track to playlist:', error);
      res.status(500).json({ error: 'Failed to add track to playlist' });
    }
  });

  // ==================== PLAYLIST TREE ====================

  // Get full tree: folders + playlists with cover art
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

  // Batch reorder folders and playlists
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

  // ==================== DIMENSION ANALYSIS ====================

  // Get dimension statistics and availability
  app.get('/api/dimensions/stats', async (req, res) => {
    try {
      const stats = await db.getDimensionStats();
      res.json(stats);
    } catch (error) {
      console.error('Error getting dimension stats:', error);
      res.status(500).json({ error: 'Failed to get dimension stats' });
    }
  });

  // Get dimensions for a specific track
  app.get('/api/dimensions/track/:id', async (req, res) => {
    const { id } = req.params;

    try {
      const track = await db.getTrackDimensions(id);
      if (!track) {
        return res.status(404).json({ error: 'Track not found' });
      }
      res.json(track);
    } catch (error) {
      console.error('Error getting track dimensions:', error);
      res.status(500).json({ error: 'Failed to get track dimensions' });
    }
  });

  // ==================== KD-TREE SEARCH ====================

  // Get neighbors for a track using KD-tree search
  app.get('/api/kd-tree/neighbors/:id', async (req, res) => {
    const { id } = req.params;
    const { embedding = 'auto', include_distances = false } = req.query;
    const resolution = req.query.resolution || 'magnifying_glass';
    const discriminator = req.query.discriminator || 'primary_d';
    const radiusSupplied = Object.prototype.hasOwnProperty.call(req.query, 'radius');
    const limitSupplied = Object.prototype.hasOwnProperty.call(req.query, 'limit');
    const parsedRadius = radiusSupplied ? parseFloat(req.query.radius) : null;
    const radiusValue = Number.isFinite(parsedRadius) ? parsedRadius : null;
    const parsedLimit = limitSupplied ? parseInt(req.query.limit, 10) : 100;
    const limitValue = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;

    try {
      if (!radialSearch.initialized) {
        await radialSearch.initialize();
      }

      const centerTrack = radialSearch.kdTree.getTrack(id);
      if (!centerTrack) {
        return res.status(404).json({ error: 'Track not found' });
      }

      let neighbors = [];
      let appliedRadius = radiusValue ?? 0.3;
      let calibrationMeta = null;

      if (embedding === 'auto' || embedding === 'pca') {
        neighbors = radialSearch.kdTree.radiusSearch(
          centerTrack,
          radiusValue ?? 0.3,
          null,
          limitValue
        );
        appliedRadius = radiusValue ?? 0.3;
      } else if (embedding === 'vae') {
        try {
          if (radiusSupplied) {
            neighbors = radialSearch.kdTree.vaeRadiusSearch(
              centerTrack,
              radiusValue,
              limitValue
            );
            appliedRadius = radiusValue;
          } else {
            const { neighbors: calibratedNeighbors, appliedRadius: calibratedRadius, calibration } =
              radialSearch.kdTree.vaeCalibratedSearch(centerTrack, resolution, limitValue);
            neighbors = calibratedNeighbors;
            appliedRadius = calibratedRadius;
            calibrationMeta = calibration;
          }
        } catch (vaeError) {
          console.warn('VAE search failed, falling back to PCA:', vaeError.message);
          neighbors = radialSearch.kdTree.radiusSearch(
            centerTrack,
            radiusValue ?? 0.3,
            null,
            limitValue
          );
        }
      }

      const includeDist = include_distances === 'true' || include_distances === true;

      const result = {
        center: {
          identifier: centerTrack.identifier,
          title: centerTrack.title,
          artist: centerTrack.artist,
          album: centerTrack.album
        },
        neighbors: neighbors.map(n => {
          const base = {
            identifier: n.identifier,
            title: n.title,
            artist: n.artist,
            album: n.album
          };
          if (includeDist && n.distance !== undefined) {
            base.distance = n.distance;
          }
          return base;
        }),
        meta: {
          embedding,
          resolution,
          appliedRadius,
          count: neighbors.length,
          calibration: calibrationMeta
        }
      };

      res.json(result);
    } catch (error) {
      console.error('Error searching KD-tree:', error);
      res.status(500).json({ error: 'Failed to search neighbors' });
    }
  });

  // Batch neighbors search
  app.post('/api/kd-tree/batch-neighbors', async (req, res) => {
    const { identifiers, embedding = 'auto', radius, limit = 50 } = req.body;

    if (!identifiers || !Array.isArray(identifiers)) {
      return res.status(400).json({ error: 'identifiers array is required' });
    }

    if (identifiers.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 identifiers per batch' });
    }

    try {
      if (!radialSearch.initialized) {
        await radialSearch.initialize();
      }

      const results = {};

      for (const id of identifiers) {
        const centerTrack = radialSearch.kdTree.getTrack(id);
        if (!centerTrack) {
          results[id] = { error: 'Track not found' };
          continue;
        }

        let neighbors = [];
        const searchRadius = radius ?? 0.3;

        if (embedding === 'vae') {
          try {
            neighbors = radialSearch.kdTree.vaeRadiusSearch(centerTrack, searchRadius, limit);
          } catch (e) {
            neighbors = radialSearch.kdTree.radiusSearch(centerTrack, searchRadius, null, limit);
          }
        } else {
          neighbors = radialSearch.kdTree.radiusSearch(centerTrack, searchRadius, null, limit);
        }

        results[id] = {
          neighbors: neighbors.map(n => ({
            identifier: n.identifier,
            distance: n.distance
          }))
        };
      }

      res.json({ results, meta: { embedding, radius: radius ?? 0.3, limit } });
    } catch (error) {
      console.error('Error in batch neighbors search:', error);
      res.status(500).json({ error: 'Failed to search neighbors' });
    }
  });

  // Get random tracks
  app.get('/api/kd-tree/random-tracks', async (req, res) => {
    const count = Math.min(parseInt(req.query.count) || 10, 100);

    try {
      if (!radialSearch.initialized) {
        await radialSearch.initialize();
      }

      const randomTracks = radialSearch.kdTree.getRandomTracks(count);

      res.json({
        tracks: randomTracks.map(t => ({
          identifier: t.identifier,
          title: t.title,
          artist: t.artist,
          album: t.album
        })),
        count: randomTracks.length
      });
    } catch (error) {
      console.error('Error getting random tracks:', error);
      res.status(500).json({ error: 'Failed to get random tracks' });
    }
  });
}

module.exports = { setupApiRoutes };
