// User data and analysis API endpoints
// Extracted from server.js for readability

function setupApiRoutes(app, { pool, radialSearch }) {

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
      const client = await pool.connect();

      try {
        const trackExists = await client.query(
          'SELECT identifier FROM music_analysis WHERE identifier = $1',
          [id]
        );

        if (trackExists.rows.length === 0) {
          return res.status(404).json({ error: 'Track not found' });
        }

        const result = await client.query(`
          INSERT INTO ratings (identifier, rating, rated_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP)
          ON CONFLICT (identifier)
          DO UPDATE SET rating = EXCLUDED.rating, rated_at = CURRENT_TIMESTAMP
          RETURNING *
        `, [id, rating]);

        res.json({
          identifier: id,
          rating: result.rows[0].rating,
          rated_at: result.rows[0].rated_at
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error updating track rating:', error);
      res.status(500).json({ error: 'Failed to update rating' });
    }
  });

  // Mark track as completed (successful crossfade)
  app.post('/api/track/:id/complete', async (req, res) => {
    const { id } = req.params;
    const { playTime } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'Missing track identifier' });
    }

    try {
      const client = await pool.connect();

      try {
        const trackExists = await client.query(
          'SELECT identifier FROM music_analysis WHERE identifier = $1',
          [id]
        );

        if (trackExists.rows.length === 0) {
          return res.status(404).json({ error: 'Track not found' });
        }

        const result = await client.query(`
          INSERT INTO completions (identifier, completed_at, play_time)
          VALUES ($1, CURRENT_TIMESTAMP, $2)
          RETURNING *
        `, [id, playTime || null]);

        res.json({
          identifier: id,
          completed_at: result.rows[0].completed_at,
          play_time: result.rows[0].play_time
        });
      } finally {
        client.release();
      }
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
      const client = await pool.connect();

      try {
        const ratingResult = await client.query(
          'SELECT rating, rated_at FROM ratings WHERE identifier = $1',
          [id]
        );

        const completionsResult = await client.query(
          'SELECT COUNT(*) as count, MAX(completed_at) as last_completed FROM completions WHERE identifier = $1',
          [id]
        );

        res.json({
          identifier: id,
          rating: ratingResult.rows[0]?.rating ?? null,
          rated_at: ratingResult.rows[0]?.rated_at ?? null,
          completions: parseInt(completionsResult.rows[0]?.count) || 0,
          last_completed: completionsResult.rows[0]?.last_completed ?? null
        });
      } finally {
        client.release();
      }
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
      const client = await pool.connect();

      try {
        const result = await client.query(`
          INSERT INTO playlists (name, description, created_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP)
          RETURNING *
        `, [name, description || null]);

        res.json(result.rows[0]);
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error creating playlist:', error);
      res.status(500).json({ error: 'Failed to create playlist' });
    }
  });

  // List playlists
  app.get('/api/playlists', async (req, res) => {
    try {
      const client = await pool.connect();

      try {
        const result = await client.query(`
          SELECT p.*, COUNT(pi.id) as track_count
          FROM playlists p
          LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
          GROUP BY p.id
          ORDER BY p.created_at DESC
        `);

        res.json(result.rows);
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error listing playlists:', error);
      res.status(500).json({ error: 'Failed to list playlists' });
    }
  });

  // Get playlist with tracks
  app.get('/api/playlists/:id', async (req, res) => {
    const { id } = req.params;

    try {
      const client = await pool.connect();

      try {
        const playlistResult = await client.query(
          'SELECT * FROM playlists WHERE id = $1',
          [id]
        );

        if (playlistResult.rows.length === 0) {
          return res.status(404).json({ error: 'Playlist not found' });
        }

        const tracksResult = await client.query(`
          SELECT pi.*, ma.bt_title, ma.bt_artist, ma.bt_album
          FROM playlist_items pi
          LEFT JOIN music_analysis ma ON pi.identifier = ma.identifier
          WHERE pi.playlist_id = $1
          ORDER BY pi.position ASC
        `, [id]);

        res.json({
          ...playlistResult.rows[0],
          tracks: tracksResult.rows
        });
      } finally {
        client.release();
      }
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
      const client = await pool.connect();

      try {
        const playlistExists = await client.query(
          'SELECT id FROM playlists WHERE id = $1',
          [id]
        );

        if (playlistExists.rows.length === 0) {
          return res.status(404).json({ error: 'Playlist not found' });
        }

        let insertPosition = position;
        if (insertPosition === undefined) {
          const maxPosResult = await client.query(
            'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM playlist_items WHERE playlist_id = $1',
            [id]
          );
          insertPosition = maxPosResult.rows[0].next_pos;
        }

        const result = await client.query(`
          INSERT INTO playlist_items (playlist_id, identifier, direction, scope, position)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [id, identifier, direction || null, scope || 'magnify', insertPosition]);

        res.json(result.rows[0]);
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error adding track to playlist:', error);
      res.status(500).json({ error: 'Failed to add track to playlist' });
    }
  });

  // ==================== DIMENSION ANALYSIS ====================

  // Get dimension statistics and availability
  app.get('/api/dimensions/stats', async (req, res) => {
    try {
      const client = await pool.connect();

      try {
        const totalResult = await client.query('SELECT COUNT(*) as count FROM music_analysis');
        const totalTracks = parseInt(totalResult.rows[0].count);

        const coreDimensions = [
          'bpm', 'danceability', 'onset_rate', 'beat_punch',
          'tonal_clarity', 'tuning_purity', 'fifths_strength',
          'chord_strength', 'chord_change_rate', 'crest', 'entropy',
          'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis',
          'spectral_energy', 'spectral_flatness', 'sub_drive', 'air_sizzle'
        ];

        const pcaDimensions = [
          'primary_d', 'tonal_pc1', 'tonal_pc2', 'tonal_pc3',
          'spectral_pc1', 'spectral_pc2', 'spectral_pc3',
          'rhythmic_pc1', 'rhythmic_pc2', 'rhythmic_pc3'
        ];

        const columnsResult = await client.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'music_analysis'
            AND column_name LIKE 'vae_latent_%'
          ORDER BY column_name
        `);
        const vaeDimensions = columnsResult.rows
          .map(row => row.column_name)
          .filter(name => /^vae_latent_\d+$/.test(name));

        const coreCompleteResult = await client.query(`
          SELECT COUNT(*) as count FROM music_analysis
          WHERE ${coreDimensions.map(dim => `${dim} IS NOT NULL`).join(' AND ')}
        `);

        const pcaCompleteResult = await client.query(`
          SELECT COUNT(*) as count FROM music_analysis
          WHERE ${pcaDimensions.map(dim => `${dim} IS NOT NULL`).join(' AND ')}
        `);

        let vaeCompleteCount = 0;
        if (vaeDimensions.length > 0) {
          const vaeCompleteResult = await client.query(`
            SELECT COUNT(*) as count FROM music_analysis
            WHERE ${vaeDimensions.map(dim => `${dim} IS NOT NULL`).join(' AND ')}
          `);
          vaeCompleteCount = parseInt(vaeCompleteResult.rows[0].count);
        }

        res.json({
          totalTracks,
          dimensions: {
            core: {
              names: coreDimensions,
              count: coreDimensions.length,
              tracksWithComplete: parseInt(coreCompleteResult.rows[0].count)
            },
            pca: {
              names: pcaDimensions,
              count: pcaDimensions.length,
              tracksWithComplete: parseInt(pcaCompleteResult.rows[0].count)
            },
            vae: {
              names: vaeDimensions,
              count: vaeDimensions.length,
              tracksWithComplete: vaeCompleteCount
            }
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error getting dimension stats:', error);
      res.status(500).json({ error: 'Failed to get dimension stats' });
    }
  });

  // Get dimensions for a specific track
  app.get('/api/dimensions/track/:id', async (req, res) => {
    const { id } = req.params;

    try {
      const client = await pool.connect();

      try {
        const result = await client.query(`
          SELECT
            identifier,
            bpm, danceability, onset_rate, beat_punch,
            tonal_clarity, tuning_purity, fifths_strength,
            chord_strength, chord_change_rate, crest, entropy,
            spectral_centroid, spectral_rolloff, spectral_kurtosis,
            spectral_energy, spectral_flatness, sub_drive, air_sizzle,
            primary_d, tonal_pc1, tonal_pc2, tonal_pc3,
            spectral_pc1, spectral_pc2, spectral_pc3,
            rhythmic_pc1, rhythmic_pc2, rhythmic_pc3
          FROM music_analysis
          WHERE identifier = $1
        `, [id]);

        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'Track not found' });
        }

        const track = result.rows[0];

        const vaeResult = await client.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_name = 'music_analysis'
            AND column_name LIKE 'vae_latent_%'
        `);

        if (vaeResult.rows.length > 0) {
          const vaeColumns = vaeResult.rows.map(r => r.column_name);
          const vaeDataResult = await client.query(`
            SELECT ${vaeColumns.join(', ')}
            FROM music_analysis
            WHERE identifier = $1
          `, [id]);

          if (vaeDataResult.rows.length > 0) {
            track.vae = vaeDataResult.rows[0];
          }
        }

        res.json(track);
      } finally {
        client.release();
      }
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
