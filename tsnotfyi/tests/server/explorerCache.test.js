const ExplorerCache = require('../../services/explorer-cache');

describe('ExplorerCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor defaults', () => {
    test('maxEntries defaults to 50', () => {
      const cache = new ExplorerCache();
      expect(cache._maxEntries).toBe(50);
    });

    test('ttlMs defaults to 5 minutes', () => {
      const cache = new ExplorerCache();
      expect(cache._ttlMs).toBe(5 * 60 * 1000);
    });
  });

  describe('has/get/set basic operations', () => {
    test('set then get returns the stored data', () => {
      const cache = new ExplorerCache();
      cache.set('track1', 'high', { waveform: [1, 2, 3] });
      expect(cache.get('track1', 'high')).toEqual({ waveform: [1, 2, 3] });
    });

    test('set then has returns true', () => {
      const cache = new ExplorerCache();
      cache.set('track1', 'high', { waveform: [] });
      expect(cache.has('track1', 'high')).toBe(true);
    });

    test('cache miss: get returns undefined', () => {
      const cache = new ExplorerCache();
      expect(cache.get('missing', 'low')).toBeUndefined();
    });

    test('cache miss: has returns false', () => {
      const cache = new ExplorerCache();
      expect(cache.has('missing', 'low')).toBe(false);
    });
  });

  describe('TTL expiration', () => {
    test('has() returns false after TTL expires', () => {
      const cache = new ExplorerCache({ ttlMs: 1000 });
      cache.set('track1', 'mid', { data: true });

      jest.advanceTimersByTime(1001);

      expect(cache.has('track1', 'mid')).toBe(false);
    });

    test('get() returns undefined after TTL expires', () => {
      const cache = new ExplorerCache({ ttlMs: 1000 });
      cache.set('track1', 'mid', { data: true });

      jest.advanceTimersByTime(1001);

      expect(cache.get('track1', 'mid')).toBeUndefined();
    });

    test('entry is accessible before TTL expires', () => {
      const cache = new ExplorerCache({ ttlMs: 1000 });
      cache.set('track1', 'mid', { data: true });

      jest.advanceTimersByTime(999);

      expect(cache.has('track1', 'mid')).toBe(true);
      expect(cache.get('track1', 'mid')).toEqual({ data: true });
    });
  });

  describe('max entries eviction', () => {
    test('oldest entry is evicted when maxEntries is reached', () => {
      const cache = new ExplorerCache({ maxEntries: 3 });

      cache.set('track1', 'low', 'data1');
      jest.advanceTimersByTime(10);
      cache.set('track2', 'low', 'data2');
      jest.advanceTimersByTime(10);
      cache.set('track3', 'low', 'data3');
      jest.advanceTimersByTime(10);

      // This should evict track1 (oldest)
      cache.set('track4', 'low', 'data4');

      expect(cache.has('track1', 'low')).toBe(false);
      expect(cache.has('track2', 'low')).toBe(true);
      expect(cache.has('track3', 'low')).toBe(true);
      expect(cache.has('track4', 'low')).toBe(true);
    });
  });

  describe('invalidate(trackId)', () => {
    test('removes all resolutions for a given track', () => {
      const cache = new ExplorerCache();
      cache.set('track1', 'low', 'lo');
      cache.set('track1', 'high', 'hi');
      cache.set('track2', 'low', 'other');

      cache.invalidate('track1');

      expect(cache.has('track1', 'low')).toBe(false);
      expect(cache.has('track1', 'high')).toBe(false);
      expect(cache.has('track2', 'low')).toBe(true);
    });
  });

  describe('invalidateAll()', () => {
    test('clears all entries', () => {
      const cache = new ExplorerCache();
      cache.set('track1', 'low', 'a');
      cache.set('track2', 'high', 'b');

      cache.invalidateAll();

      expect(cache.size).toBe(0);
      expect(cache.has('track1', 'low')).toBe(false);
      expect(cache.has('track2', 'high')).toBe(false);
    });
  });

  describe('size getter', () => {
    test('reflects current entry count', () => {
      const cache = new ExplorerCache();
      expect(cache.size).toBe(0);

      cache.set('track1', 'low', 'a');
      expect(cache.size).toBe(1);

      cache.set('track2', 'low', 'b');
      expect(cache.size).toBe(2);

      cache.invalidate('track1');
      expect(cache.size).toBe(1);
    });
  });

  describe('iterator (for...of)', () => {
    test('yields [key, data] pairs', () => {
      const cache = new ExplorerCache();
      cache.set('track1', 'low', 'data1');
      cache.set('track2', 'high', 'data2');

      const entries = [...cache];

      expect(entries).toEqual([
        ['track1_low', 'data1'],
        ['track2_high', 'data2']
      ]);
    });

    test('skips expired entries', () => {
      const cache = new ExplorerCache({ ttlMs: 1000 });
      cache.set('track1', 'low', 'old');

      jest.advanceTimersByTime(1001);

      cache.set('track2', 'low', 'fresh');

      const entries = [...cache];

      expect(entries).toEqual([['track2_low', 'fresh']]);
    });
  });
});
