// Data Access Layer — centralizes all raw SQL operations
// Phase 1: Extracted from server.js, routes/api.js, routes/playlist.js

const serverLogger = require('../server-logger');
const dbLog = serverLogger.createLogger('database');

class DataAccess {
  constructor(pool) {
    this._pool = pool;
  }

  get pool() {
    return this._pool;
  }

  async close() {
    await this._pool.end();
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  async _query(text, params) {
    const client = await this._pool.connect();
    try {
      return await client.query(text, params);
    } finally {
      client.release();
    }
  }

  async _transaction(fn) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Track existence ────────────────────────────────────────────────────────

  async trackExists(identifier) {
    const result = await this._query(
      'SELECT identifier FROM music_analysis WHERE identifier = $1',
      [identifier]
    );
    return result.rows.length > 0;
  }

  // ─── Ratings ────────────────────────────────────────────────────────────────

  async upsertRating(identifier, rating) {
    const exists = await this.trackExists(identifier);
    if (!exists) return null;

    const result = await this._query(`
      INSERT INTO ratings (identifier, rating, rated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (identifier)
      DO UPDATE SET rating = EXCLUDED.rating, rated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [identifier, rating]);

    return {
      identifier,
      rating: result.rows[0].rating,
      rated_at: result.rows[0].rated_at
    };
  }

  async getRatingWithStats(identifier) {
    const ratingResult = await this._query(
      'SELECT rating, rated_at FROM ratings WHERE identifier = $1',
      [identifier]
    );
    const statsResult = await this._query(
      'SELECT completion_count, last_completed FROM play_stats WHERE identifier = $1',
      [identifier]
    );
    return {
      identifier,
      rating: ratingResult.rows[0]?.rating ?? null,
      rated_at: ratingResult.rows[0]?.rated_at ?? null,
      completions: parseInt(statsResult.rows[0]?.completion_count) || 0,
      last_completed: statsResult.rows[0]?.last_completed ?? null
    };
  }

  // ─── Play stats ─────────────────────────────────────────────────────────────

  async recordCompletion(identifier) {
    const result = await this._query(`
      INSERT INTO play_stats (identifier, completion_count, last_completed)
      VALUES ($1, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (identifier)
      DO UPDATE SET completion_count = play_stats.completion_count + 1,
                    last_completed = CURRENT_TIMESTAMP
      RETURNING *
    `, [identifier]);
    return {
      identifier,
      completed_at: result.rows[0].last_completed,
      completions: result.rows[0].completion_count
    };
  }

  async recordCompletionChecked(identifier) {
    const exists = await this.trackExists(identifier);
    if (!exists) return null;
    return this.recordCompletion(identifier);
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  async trigramSearch(query, limit = 50) {
    const result = await this._query(`
      SELECT
        identifier,
        bt_path,
        bt_title,
        bt_artist,
        bt_album,
        bt_year,
        similarity(path_keywords, $1) AS score
      FROM music_analysis
      WHERE path_keywords % $1
      ORDER BY score DESC
      LIMIT $2
    `, [query, limit]);
    return result.rows;
  }

  // ─── Playlists ──────────────────────────────────────────────────────────────

  async createPlaylist(name, description) {
    const result = await this._query(`
      INSERT INTO playlists (name, description, created_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      RETURNING *
    `, [name, description || null]);
    return result.rows[0];
  }

  async getPlaylists() {
    const result = await this._query(`
      SELECT p.*, COUNT(pi.id) as track_count
      FROM playlists p
      LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    return result.rows;
  }

  async getPlaylistById(id) {
    const result = await this._query('SELECT * FROM playlists WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async getPlaylistWithTracks(id) {
    const playlistResult = await this._query(
      'SELECT * FROM playlists WHERE id = $1', [id]
    );
    if (playlistResult.rows.length === 0) return null;

    const tracksResult = await this._query(`
      SELECT pi.*, ma.bt_title, ma.bt_artist, ma.bt_album, ma.bt_path, ma.beets_meta
      FROM playlist_items pi
      LEFT JOIN music_analysis ma ON pi.identifier = ma.identifier
      WHERE pi.playlist_id = $1
      ORDER BY pi.position ASC
    `, [id]);

    const tracks = tracksResult.rows.map(row => {
      let albumCover = '/images/albumcover.png';
      try {
        const meta = row.beets_meta ? JSON.parse(row.beets_meta) : null;
        if (meta?.album?.artpath?.length > 0) albumCover = meta.album.artpath;
      } catch (_) { /* ignore parse errors */ }

      let trackPath = null;
      if (Buffer.isBuffer(row.bt_path)) {
        trackPath = row.bt_path.toString('utf8');
      } else if (typeof row.bt_path === 'string' && row.bt_path.startsWith('\\x')) {
        try { trackPath = Buffer.from(row.bt_path.slice(2), 'hex').toString('utf8'); } catch (_) {}
      } else if (row.bt_path) {
        trackPath = String(row.bt_path);
      }

      return {
        identifier: row.identifier,
        position: row.position,
        direction: row.direction,
        scope: row.scope,
        title: row.bt_title,
        artist: row.bt_artist,
        album: row.bt_album,
        albumCover,
        path: trackPath
      };
    });

    return { ...playlistResult.rows[0], tracks };
  }

  async getPlaylistByName(name) {
    const playlistResult = await this._query(
      'SELECT * FROM playlists WHERE name = $1', [name]
    );
    if (playlistResult.rows.length === 0) return null;

    const tracksResult = await this._query(`
      SELECT pi.identifier, pi.direction, pi.scope, pi.position
      FROM playlist_items pi
      WHERE pi.playlist_id = $1
      ORDER BY pi.position ASC
    `, [playlistResult.rows[0].id]);

    const playlist = playlistResult.rows[0];
    playlist.tracks = tracksResult.rows;
    return playlist;
  }

  async addToPlaylist(playlistId, identifier, direction, scope, position) {
    const playlistExists = await this._query(
      'SELECT id FROM playlists WHERE id = $1', [playlistId]
    );
    if (playlistExists.rows.length === 0) return null;

    let insertPosition = position;
    if (insertPosition === undefined) {
      const maxPosResult = await this._query(
        'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM playlist_items WHERE playlist_id = $1',
        [playlistId]
      );
      insertPosition = maxPosResult.rows[0].next_pos;
    }

    const result = await this._query(`
      INSERT INTO playlist_items (playlist_id, identifier, direction, scope, position)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [playlistId, identifier, direction || null, scope || 'magnify', insertPosition]);

    return result.rows[0];
  }

  async updatePlaylist(id, { name, folder_id, position, description } = {}) {
    const sets = [];
    const vals = [];
    let n = 1;
    if (name !== undefined) { sets.push(`name = $${n++}`); vals.push(name); }
    if (folder_id !== undefined) { sets.push(`folder_id = $${n++}`); vals.push(folder_id); }
    if (position !== undefined) { sets.push(`position = $${n++}`); vals.push(position); }
    if (description !== undefined) { sets.push(`description = $${n++}`); vals.push(description); }
    if (sets.length === 0) return { error: 'nothing_to_update' };
    vals.push(id);
    const result = await this._query(
      `UPDATE playlists SET ${sets.join(', ')} WHERE id = $${n} RETURNING *`,
      vals
    );
    return result.rows[0] || null;
  }

  async deletePlaylist(id) {
    const result = await this._query(
      'DELETE FROM playlists WHERE id = $1 RETURNING *', [id]
    );
    return result.rows.length > 0;
  }

  // ─── Playlist tree ──────────────────────────────────────────────────────────

  async getPlaylistTree() {
    const foldersResult = await this._query(
      'SELECT * FROM playlist_folders ORDER BY position, name'
    );
    const playlistsResult = await this._query(`
      SELECT p.id, p.name, p.description, p.folder_id, p.position, p.cursor_position,
             p.created_at, p.updated_at,
             COUNT(pi.id)::int as track_count
      FROM playlists p
      LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
      GROUP BY p.id
      ORDER BY p.position, p.name
    `);

    const playlistIds = playlistsResult.rows.map(p => p.id);
    let coverMap = {};
    if (playlistIds.length > 0) {
      const coversResult = await this._query(`
        SELECT DISTINCT ON (sub.playlist_id, sub.position)
          sub.playlist_id, sub.artpath
        FROM (
          SELECT pi.playlist_id, pi.position,
            COALESCE(
              (ma.beets_meta::json->'album'->>'artpath'),
              '/images/albumcover.png'
            ) as artpath
          FROM playlist_items pi
          JOIN music_analysis ma ON pi.identifier = ma.identifier
          WHERE pi.playlist_id = ANY($1) AND pi.position < 4
          ORDER BY pi.playlist_id, pi.position
        ) sub
      `, [playlistIds]);
      for (const row of coversResult.rows) {
        if (!coverMap[row.playlist_id]) coverMap[row.playlist_id] = [];
        coverMap[row.playlist_id].push(row.artpath);
      }
    }

    const playlists = playlistsResult.rows.map(p => ({
      ...p,
      covers: coverMap[p.id] || []
    }));

    return { folders: foldersResult.rows, playlists };
  }

  // ─── Folders ────────────────────────────────────────────────────────────────

  async createFolder(name, parentId, position) {
    const result = await this._query(
      `INSERT INTO playlist_folders (name, parent_id, position)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, parentId || null, position || 0]
    );
    return result.rows[0];
  }

  async updateFolder(id, { name, parent_id, position } = {}) {
    const sets = [];
    const vals = [];
    let n = 1;
    if (name !== undefined) { sets.push(`name = $${n++}`); vals.push(name); }
    if (parent_id !== undefined) { sets.push(`parent_id = $${n++}`); vals.push(parent_id); }
    if (position !== undefined) { sets.push(`position = $${n++}`); vals.push(position); }
    if (sets.length === 0) return { error: 'nothing_to_update' };
    vals.push(id);
    const result = await this._query(
      `UPDATE playlist_folders SET ${sets.join(', ')} WHERE id = $${n} RETURNING *`,
      vals
    );
    return result.rows[0] || null;
  }

  async deleteFolder(id) {
    const result = await this._query(
      'DELETE FROM playlist_folders WHERE id = $1 RETURNING *', [id]
    );
    return result.rows.length > 0;
  }

  // ─── Batch reorder ──────────────────────────────────────────────────────────

  async reorderItems(folders, playlists) {
    await this._transaction(async (client) => {
      if (Array.isArray(folders)) {
        for (const f of folders) {
          await client.query(
            'UPDATE playlist_folders SET parent_id = $1, position = $2 WHERE id = $3',
            [f.parent_id ?? null, f.position, f.id]
          );
        }
      }
      if (Array.isArray(playlists)) {
        for (const p of playlists) {
          await client.query(
            'UPDATE playlists SET folder_id = $1, position = $2 WHERE id = $3',
            [p.folder_id ?? null, p.position, p.id]
          );
        }
      }
    });
  }

  // ─── Dimension analysis ─────────────────────────────────────────────────────

  async getDimensionStats() {
    const totalResult = await this._query('SELECT COUNT(*) as count FROM music_analysis');
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

    const columnsResult = await this._query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'music_analysis'
        AND column_name LIKE 'vae_latent_%'
      ORDER BY column_name
    `);
    const vaeDimensions = columnsResult.rows
      .map(row => row.column_name)
      .filter(name => /^vae_latent_\d+$/.test(name));

    const coreCompleteResult = await this._query(`
      SELECT COUNT(*) as count FROM music_analysis
      WHERE ${coreDimensions.map(dim => `${dim} IS NOT NULL`).join(' AND ')}
    `);

    const pcaCompleteResult = await this._query(`
      SELECT COUNT(*) as count FROM music_analysis
      WHERE ${pcaDimensions.map(dim => `${dim} IS NOT NULL`).join(' AND ')}
    `);

    let vaeCompleteCount = 0;
    if (vaeDimensions.length > 0) {
      const vaeCompleteResult = await this._query(`
        SELECT COUNT(*) as count FROM music_analysis
        WHERE ${vaeDimensions.map(dim => `${dim} IS NOT NULL`).join(' AND ')}
      `);
      vaeCompleteCount = parseInt(vaeCompleteResult.rows[0].count);
    }

    return {
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
    };
  }

  async getTrackDimensions(identifier) {
    const result = await this._query(`
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
    `, [identifier]);

    if (result.rows.length === 0) return null;

    const track = result.rows[0];

    const vaeResult = await this._query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'music_analysis'
        AND column_name LIKE 'vae_latent_%'
    `);

    if (vaeResult.rows.length > 0) {
      const vaeColumns = vaeResult.rows.map(r => r.column_name);
      const vaeDataResult = await this._query(`
        SELECT ${vaeColumns.join(', ')}
        FROM music_analysis
        WHERE identifier = $1
      `, [identifier]);

      if (vaeDataResult.rows.length > 0) {
        track.vae = vaeDataResult.rows[0];
      }
    }

    return track;
  }
}

module.exports = DataAccess;
