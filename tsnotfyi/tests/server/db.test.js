jest.mock('../../server-logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })
}));

const DataAccess = require('../../services/db');

function createMockPool(queryResults = {}) {
  const client = {
    query: jest.fn(async (text, params) => {
      for (const [pattern, result] of Object.entries(queryResults)) {
        if (text.includes(pattern)) return result;
      }
      return { rows: [] };
    }),
    release: jest.fn()
  };
  return {
    connect: jest.fn(async () => client),
    query: jest.fn(async (text, params) => client.query(text, params)),
    end: jest.fn(),
    _client: client
  };
}

describe('DataAccess', () => {
  let pool;
  let db;

  beforeEach(() => {
    pool = createMockPool();
    db = new DataAccess(pool);
  });

  describe('pool getter', () => {
    it('returns the pool', () => {
      expect(db.pool).toBe(pool);
    });
  });

  describe('close()', () => {
    it('calls pool.end()', async () => {
      await db.close();
      expect(pool.end).toHaveBeenCalled();
    });
  });

  describe('trackExists', () => {
    it('returns true when track is found', async () => {
      pool._client.query.mockResolvedValueOnce({
        rows: [{ identifier: 'abc123' }]
      });
      const result = await db.trackExists('abc123');
      expect(result).toBe(true);
    });

    it('returns false when track is not found', async () => {
      pool._client.query.mockResolvedValueOnce({ rows: [] });
      const result = await db.trackExists('missing');
      expect(result).toBe(false);
    });
  });

  describe('upsertRating', () => {
    it('returns null when track does not exist', async () => {
      // trackExists query returns empty
      pool._client.query.mockResolvedValueOnce({ rows: [] });
      const result = await db.upsertRating('missing', 5);
      expect(result).toBeNull();
    });

    it('returns rating object when track exists', async () => {
      const ratedAt = new Date();
      // trackExists query
      pool._client.query.mockResolvedValueOnce({
        rows: [{ identifier: 'abc123' }]
      });
      // upsert query
      pool._client.query.mockResolvedValueOnce({
        rows: [{ rating: 5, rated_at: ratedAt }]
      });

      const result = await db.upsertRating('abc123', 5);
      expect(result).toEqual({
        identifier: 'abc123',
        rating: 5,
        rated_at: ratedAt
      });
    });
  });

  describe('recordCompletion', () => {
    it('returns completion stats', async () => {
      const completedAt = new Date();
      pool._client.query.mockResolvedValueOnce({
        rows: [{ last_completed: completedAt, completion_count: 3 }]
      });
      const result = await db.recordCompletion('abc123');
      expect(result).toEqual({
        identifier: 'abc123',
        completed_at: completedAt,
        completions: 3
      });
    });
  });

  describe('recordCompletionChecked', () => {
    it('returns null when track does not exist', async () => {
      pool._client.query.mockResolvedValueOnce({ rows: [] });
      const result = await db.recordCompletionChecked('missing');
      expect(result).toBeNull();
    });

    it('returns completion stats when track exists', async () => {
      const completedAt = new Date();
      // trackExists
      pool._client.query.mockResolvedValueOnce({
        rows: [{ identifier: 'abc123' }]
      });
      // recordCompletion
      pool._client.query.mockResolvedValueOnce({
        rows: [{ last_completed: completedAt, completion_count: 1 }]
      });
      const result = await db.recordCompletionChecked('abc123');
      expect(result).toEqual({
        identifier: 'abc123',
        completed_at: completedAt,
        completions: 1
      });
    });
  });

  describe('trigramSearch', () => {
    it('passes query and limit to SQL', async () => {
      const rows = [{ identifier: 'abc', score: 0.8 }];
      pool._client.query.mockResolvedValueOnce({ rows });
      const result = await db.trigramSearch('test query', 10);
      expect(result).toEqual(rows);
      expect(pool._client.query).toHaveBeenCalledWith(
        expect.stringContaining('similarity'),
        ['test query', 10]
      );
    });

    it('defaults limit to 50', async () => {
      pool._client.query.mockResolvedValueOnce({ rows: [] });
      await db.trigramSearch('test');
      expect(pool._client.query).toHaveBeenCalledWith(
        expect.any(String),
        ['test', 50]
      );
    });
  });

  describe('createPlaylist', () => {
    it('returns created row', async () => {
      const row = { id: 1, name: 'My Playlist', description: null };
      pool._client.query.mockResolvedValueOnce({ rows: [row] });
      const result = await db.createPlaylist('My Playlist');
      expect(result).toEqual(row);
    });
  });

  describe('getPlaylists', () => {
    it('returns array of rows', async () => {
      const rows = [
        { id: 1, name: 'P1', track_count: '3' },
        { id: 2, name: 'P2', track_count: '0' }
      ];
      pool._client.query.mockResolvedValueOnce({ rows });
      const result = await db.getPlaylists();
      expect(result).toEqual(rows);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('addToPlaylist', () => {
    it('returns null when playlist does not exist', async () => {
      pool._client.query.mockResolvedValueOnce({ rows: [] });
      const result = await db.addToPlaylist(999, 'track1');
      expect(result).toBeNull();
    });

    it('calculates next position when not provided', async () => {
      // playlist exists
      pool._client.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // max position
      pool._client.query.mockResolvedValueOnce({ rows: [{ next_pos: 5 }] });
      // insert
      const insertedRow = { id: 10, playlist_id: 1, identifier: 'track1', position: 5 };
      pool._client.query.mockResolvedValueOnce({ rows: [insertedRow] });

      const result = await db.addToPlaylist(1, 'track1');
      expect(result).toEqual(insertedRow);
    });

    it('uses provided position directly', async () => {
      // playlist exists
      pool._client.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      // insert (no max position query needed)
      const insertedRow = { id: 10, playlist_id: 1, identifier: 'track1', position: 3 };
      pool._client.query.mockResolvedValueOnce({ rows: [insertedRow] });

      const result = await db.addToPlaylist(1, 'track1', null, null, 3);
      expect(result).toEqual(insertedRow);
      // Should only have 2 queries: exists check + insert (no max position)
      expect(pool._client.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteFolder', () => {
    it('returns true when deleted', async () => {
      pool._client.query.mockResolvedValueOnce({
        rows: [{ id: 1, name: 'Folder' }]
      });
      const result = await db.deleteFolder(1);
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      pool._client.query.mockResolvedValueOnce({ rows: [] });
      const result = await db.deleteFolder(999);
      expect(result).toBe(false);
    });
  });

  describe('deletePlaylist', () => {
    it('returns true when deleted', async () => {
      pool._client.query.mockResolvedValueOnce({
        rows: [{ id: 1, name: 'Playlist' }]
      });
      const result = await db.deletePlaylist(1);
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      pool._client.query.mockResolvedValueOnce({ rows: [] });
      const result = await db.deletePlaylist(999);
      expect(result).toBe(false);
    });
  });

  describe('reorderItems', () => {
    it('uses transaction (BEGIN/COMMIT)', async () => {
      const folders = [{ id: 1, parent_id: null, position: 0 }];
      const playlists = [{ id: 1, folder_id: 1, position: 0 }];

      await db.reorderItems(folders, playlists);

      const calls = pool._client.query.mock.calls.map(c => c[0]);
      expect(calls[0]).toBe('BEGIN');
      expect(calls[calls.length - 1]).toBe('COMMIT');
    });

    it('rolls back on error', async () => {
      pool._client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')); // folder update fails

      const folders = [{ id: 1, parent_id: null, position: 0 }];
      await expect(db.reorderItems(folders, [])).rejects.toThrow('DB error');

      const calls = pool._client.query.mock.calls.map(c => c[0]);
      expect(calls).toContain('ROLLBACK');
    });

    it('releases client after success', async () => {
      await db.reorderItems([], []);
      expect(pool._client.release).toHaveBeenCalled();
    });

    it('releases client after error', async () => {
      pool._client.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('fail'));

      await expect(db.reorderItems([{ id: 1, parent_id: null, position: 0 }], []))
        .rejects.toThrow();
      expect(pool._client.release).toHaveBeenCalled();
    });
  });
});
