const SessionState = require('../../services/session-state');

describe('SessionState', () => {
  describe('constructor with defaults', () => {
    test('sessionId defaults to null', () => {
      const state = new SessionState();
      expect(state.sessionId).toBeNull();
    });

    test('sessionType defaults to anonymous', () => {
      const state = new SessionState();
      expect(state.sessionType).toBe('anonymous');
    });

    test('sessionName defaults to null', () => {
      const state = new SessionState();
      expect(state.sessionName).toBeNull();
    });

    test('ephemeral defaults to false', () => {
      const state = new SessionState();
      expect(state.ephemeral).toBe(false);
    });

    test('stack defaults to empty array', () => {
      const state = new SessionState();
      expect(state.stack).toEqual([]);
    });

    test('stackIndex defaults to 0', () => {
      const state = new SessionState();
      expect(state.stackIndex).toBe(0);
    });

    test('positionSeconds defaults to 0', () => {
      const state = new SessionState();
      expect(state.positionSeconds).toBe(0);
    });

    test('noArtist defaults to true', () => {
      const state = new SessionState();
      expect(state.noArtist).toBe(true);
    });

    test('noAlbum defaults to true', () => {
      const state = new SessionState();
      expect(state.noAlbum).toBe(true);
    });

    test('stackTotalCount defaults to 15', () => {
      const state = new SessionState();
      expect(state.stackTotalCount).toBe(15);
    });

    test('stackRandomCount defaults to 3', () => {
      const state = new SessionState();
      expect(state.stackRandomCount).toBe(3);
    });

    test('explorerResolution defaults to adaptive', () => {
      const state = new SessionState();
      expect(state.explorerResolution).toBe('adaptive');
    });

    test('currentTrack defaults to null', () => {
      const state = new SessionState();
      expect(state.currentTrack).toBeNull();
    });
  });

  describe('constructor with opts', () => {
    test('sets all properties from options', () => {
      const opts = {
        sessionId: 'sess-1',
        sessionType: 'named',
        sessionName: 'My Session',
        ephemeral: true,
        stack: [{ identifier: 't1' }],
        stackIndex: 2,
        positionSeconds: 42,
        seenArtists: ['artist1'],
        seenAlbums: ['album1'],
        seenTracks: ['track1'],
        failedTrackAttempts: [['id1', 3]],
        noArtist: false,
        noAlbum: false,
        stackTotalCount: 20,
        stackRandomCount: 5,
        explorerResolution: 'high',
        currentTrack: { identifier: 'ct1' },
      };

      const state = new SessionState(opts);

      expect(state.sessionId).toBe('sess-1');
      expect(state.sessionType).toBe('named');
      expect(state.sessionName).toBe('My Session');
      expect(state.ephemeral).toBe(true);
      expect(state.stack).toEqual([{ identifier: 't1' }]);
      expect(state.stackIndex).toBe(2);
      expect(state.positionSeconds).toBe(42);
      expect(state.noArtist).toBe(false);
      expect(state.noAlbum).toBe(false);
      expect(state.stackTotalCount).toBe(20);
      expect(state.stackRandomCount).toBe(5);
      expect(state.explorerResolution).toBe('high');
      expect(state.currentTrack).toEqual({ identifier: 'ct1' });
    });
  });

  describe('Sets are constructed from arrays', () => {
    test('seenArtists is a Set', () => {
      const state = new SessionState({ seenArtists: ['a', 'b'] });
      expect(state.seenArtists).toBeInstanceOf(Set);
      expect(state.seenArtists.size).toBe(2);
      expect(state.seenArtists.has('a')).toBe(true);
      expect(state.seenArtists.has('b')).toBe(true);
    });

    test('seenAlbums is a Set', () => {
      const state = new SessionState({ seenAlbums: ['x'] });
      expect(state.seenAlbums).toBeInstanceOf(Set);
      expect(state.seenAlbums.size).toBe(1);
    });

    test('seenTracks is a Set', () => {
      const state = new SessionState({ seenTracks: ['t1', 't2', 't3'] });
      expect(state.seenTracks).toBeInstanceOf(Set);
      expect(state.seenTracks.size).toBe(3);
    });
  });

  describe('Map from entries', () => {
    test('failedTrackAttempts is a Map with correct entries', () => {
      const state = new SessionState({ failedTrackAttempts: [['id1', 3], ['id2', 1]] });
      expect(state.failedTrackAttempts).toBeInstanceOf(Map);
      expect(state.failedTrackAttempts.get('id1')).toBe(3);
      expect(state.failedTrackAttempts.get('id2')).toBe(1);
    });
  });

  describe('serialize()', () => {
    test('produces expected shape with all keys', () => {
      const state = new SessionState();
      const serialized = state.serialize();

      const expectedKeys = [
        'sessionType', 'sessionName', 'stack', 'stackIndex', 'positionSeconds',
        'ephemeral', 'seenArtists', 'seenAlbums', 'seenTracks', 'seenTrackArtists',
        'seenTrackAlbums', 'sessionHistory', 'failedTrackAttempts', 'noArtist',
        'noAlbum', 'stackTotalCount', 'stackRandomCount', 'currentTrackId',
        'currentTrackDirection', 'created', 'lastAccess'
      ];

      for (const key of expectedKeys) {
        expect(serialized).toHaveProperty(key);
      }
    });

    test('converts Sets to arrays', () => {
      const state = new SessionState({ seenArtists: ['a', 'b'], seenAlbums: ['x'] });
      const serialized = state.serialize();

      expect(Array.isArray(serialized.seenArtists)).toBe(true);
      expect(serialized.seenArtists).toEqual(['a', 'b']);
      expect(Array.isArray(serialized.seenAlbums)).toBe(true);
      expect(serialized.seenAlbums).toEqual(['x']);
    });

    test('converts Map to entries array', () => {
      const state = new SessionState({ failedTrackAttempts: [['id1', 3]] });
      const serialized = state.serialize();

      expect(Array.isArray(serialized.failedTrackAttempts)).toBe(true);
      expect(serialized.failedTrackAttempts).toEqual([['id1', 3]]);
    });

    test('includes lastAccess timestamp', () => {
      const state = new SessionState();
      const serialized = state.serialize();

      expect(serialized.lastAccess).toBeDefined();
      expect(typeof serialized.lastAccess).toBe('string');
      // Should be a valid ISO date
      expect(() => new Date(serialized.lastAccess)).not.toThrow();
    });
  });

  describe('round-trip serialization', () => {
    test('fromSerialized produces equivalent state', () => {
      const original = new SessionState({
        sessionType: 'named',
        sessionName: 'Test',
        stack: [{ identifier: 't1' }],
        stackIndex: 3,
        positionSeconds: 99,
        noArtist: false,
        noAlbum: false,
        stackTotalCount: 25,
        stackRandomCount: 7,
      });

      const restored = SessionState.fromSerialized(original.serialize());

      expect(restored.sessionType).toBe('named');
      expect(restored.sessionName).toBe('Test');
      expect(restored.stack).toEqual([{ identifier: 't1' }]);
      expect(restored.stackIndex).toBe(3);
      expect(restored.positionSeconds).toBe(99);
      expect(restored.noArtist).toBe(false);
      expect(restored.noAlbum).toBe(false);
      expect(restored.stackTotalCount).toBe(25);
      expect(restored.stackRandomCount).toBe(7);
    });

    test('preserves Sets through round-trip', () => {
      const original = new SessionState({ seenArtists: ['a', 'b', 'c'] });
      const restored = SessionState.fromSerialized(original.serialize());

      expect(restored.seenArtists).toBeInstanceOf(Set);
      expect(restored.seenArtists.size).toBe(3);
      expect(restored.seenArtists.has('a')).toBe(true);
      expect(restored.seenArtists.has('b')).toBe(true);
      expect(restored.seenArtists.has('c')).toBe(true);
    });

    test('preserves Map entries through round-trip', () => {
      const original = new SessionState({ failedTrackAttempts: [['id1', 3], ['id2', 5]] });
      const restored = SessionState.fromSerialized(original.serialize());

      expect(restored.failedTrackAttempts).toBeInstanceOf(Map);
      expect(restored.failedTrackAttempts.get('id1')).toBe(3);
      expect(restored.failedTrackAttempts.get('id2')).toBe(5);
    });

    test('preserves stack array through round-trip', () => {
      const stack = [
        { identifier: 't1', title: 'Track 1' },
        { identifier: 't2', title: 'Track 2' },
      ];
      const original = new SessionState({ stack });
      const restored = SessionState.fromSerialized(original.serialize());

      expect(restored.stack).toEqual(stack);
    });
  });

  describe('fromSerialized with missing fields (backward compat)', () => {
    test('uses defaults for missing fields', () => {
      const restored = SessionState.fromSerialized({});

      expect(restored.sessionType).toBe('anonymous');
      expect(restored.stack).toEqual([]);
      expect(restored.stackIndex).toBe(0);
      expect(restored.positionSeconds).toBe(0);
      expect(restored.seenArtists).toBeInstanceOf(Set);
      expect(restored.seenArtists.size).toBe(0);
      expect(restored.failedTrackAttempts).toBeInstanceOf(Map);
      expect(restored.failedTrackAttempts.size).toBe(0);
      expect(restored.noArtist).toBe(true);
      expect(restored.noAlbum).toBe(true);
    });
  });
});
