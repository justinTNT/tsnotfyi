jest.mock('../../schemas/track-definitions', () => ({
  getTrackTitle: jest.fn((track) => {
    if (track?.path) {
      const parts = track.path.split('/');
      return parts[parts.length - 1].replace(/\.\w+$/, '');
    }
    return null;
  })
}));

const {
  buildTrackMetadata,
  cloneFeatureMap,
  clonePcaMap,
  cloneVaeData,
  mergeFeatureMaps,
  mergePcaMaps,
  pruneEmptyStrings,
  cloneAndSanitizeBeetsMeta,
  hydrateTrackRecord,
  getAdjustedTrackDuration
} = require('../../services/track-utils');

describe('buildTrackMetadata', () => {
  it('returns correct shape with title/artist/album/path', () => {
    const track = {
      identifier: 'abc',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      path: '/music/song.mp3',
      extraField: 'ignored'
    };
    const result = buildTrackMetadata(track);
    expect(result).toEqual({
      identifier: 'abc',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      path: '/music/song.mp3',
      track: null,
      disc: null
    });
  });

  it('returns null for falsy input', () => {
    expect(buildTrackMetadata(null)).toBeNull();
    expect(buildTrackMetadata(undefined)).toBeNull();
  });

  it('uses md5 as fallback identifier', () => {
    const result = buildTrackMetadata({ md5: 'hash123' });
    expect(result.identifier).toBe('hash123');
  });
});

describe('cloneFeatureMap', () => {
  it('returns deep clone', () => {
    const features = { bpm: 120, energy: 0.8 };
    const clone = cloneFeatureMap(features);
    expect(clone).toEqual(features);
    clone.bpm = 999;
    expect(features.bpm).toBe(120);
  });

  it('returns null for falsy input', () => {
    expect(cloneFeatureMap(null)).toBeNull();
    expect(cloneFeatureMap(undefined)).toBeNull();
  });

  it('skips undefined values', () => {
    const features = { bpm: 120, energy: undefined };
    const clone = cloneFeatureMap(features);
    expect(clone).toEqual({ bpm: 120 });
    expect('energy' in clone).toBe(false);
  });
});

describe('clonePcaMap', () => {
  it('deep clones PCA structure', () => {
    const pca = {
      primary_d: 0.5,
      tonal: [0.1, 0.2, 0.3],
      spectral: [0.4, 0.5, 0.6],
      rhythmic: [0.7, 0.8, 0.9]
    };
    const clone = clonePcaMap(pca);
    expect(clone).toEqual(pca);
    clone.tonal[0] = 999;
    expect(pca.tonal[0]).toBe(0.1);
  });

  it('returns null for falsy input', () => {
    expect(clonePcaMap(null)).toBeNull();
  });
});

describe('cloneVaeData', () => {
  it('deep clones VAE data', () => {
    const vae = {
      latent: [0.1, 0.2, 0.3],
      model_version: 'v1',
      computed_at: '2024-01-01'
    };
    const clone = cloneVaeData(vae);
    expect(clone).toEqual(vae);
    clone.latent[0] = 999;
    expect(vae.latent[0]).toBe(0.1);
  });

  it('returns null for falsy input', () => {
    expect(cloneVaeData(null)).toBeNull();
  });

  it('sets latent to null when not an array', () => {
    const vae = { model_version: 'v1' };
    const clone = cloneVaeData(vae);
    expect(clone.latent).toBeNull();
    expect(clone.model_version).toBe('v1');
  });
});

describe('mergeFeatureMaps', () => {
  it('merges multiple sources, later sources override', () => {
    const a = { bpm: 100, energy: 0.5 };
    const b = { bpm: 120, loudness: -5 };
    const result = mergeFeatureMaps(a, b);
    expect(result).toEqual({ bpm: 120, energy: 0.5, loudness: -5 });
  });

  it('returns null when all sources are empty', () => {
    expect(mergeFeatureMaps(null, undefined)).toBeNull();
  });

  it('skips null/undefined values from sources', () => {
    const result = mergeFeatureMaps({ bpm: 120, energy: null });
    expect(result).toEqual({ bpm: 120 });
  });
});

describe('mergePcaMaps', () => {
  it('merges PCA data from multiple sources', () => {
    const a = { primary_d: 0.5, tonal: [0.1, 0.2] };
    const b = { spectral: [0.3, 0.4] };
    const result = mergePcaMaps(a, b);
    expect(result.primary_d).toBe(0.5);
    expect(result.tonal).toEqual([0.1, 0.2]);
    expect(result.spectral).toEqual([0.3, 0.4]);
  });

  it('later sources override earlier', () => {
    const a = { primary_d: 0.5 };
    const b = { primary_d: 0.9 };
    const result = mergePcaMaps(a, b);
    expect(result.primary_d).toBe(0.9);
  });

  it('returns null when all sources are falsy', () => {
    expect(mergePcaMaps(null, undefined)).toBeNull();
  });
});

describe('pruneEmptyStrings', () => {
  it('removes empty strings', () => {
    expect(pruneEmptyStrings('')).toBeUndefined();
    expect(pruneEmptyStrings('  ')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(pruneEmptyStrings('  hello  ')).toBe('hello');
  });

  it('passes through null/undefined', () => {
    expect(pruneEmptyStrings(null)).toBeNull();
    expect(pruneEmptyStrings(undefined)).toBeUndefined();
  });

  it('passes through numbers', () => {
    expect(pruneEmptyStrings(42)).toBe(42);
  });

  it('recurses into objects', () => {
    const input = { a: 'hello', b: '', c: { d: '  ', e: 'world' } };
    const result = pruneEmptyStrings(input);
    expect(result).toEqual({ a: 'hello', c: { e: 'world' } });
  });

  it('recurses into arrays', () => {
    const input = ['hello', '', '  ', 'world'];
    const result = pruneEmptyStrings(input);
    expect(result).toEqual(['hello', 'world']);
  });

  it('returns undefined for object with all empty strings', () => {
    expect(pruneEmptyStrings({ a: '', b: '  ' })).toBeUndefined();
  });
});

describe('cloneAndSanitizeBeetsMeta', () => {
  it('clones and prunes empty strings from beets metadata', () => {
    const meta = { title: 'Song', artist: '', album: '  Album  ' };
    const result = cloneAndSanitizeBeetsMeta(meta);
    expect(result).toEqual({ title: 'Song', album: 'Album' });
    expect(result).not.toBe(meta);
  });

  it('returns null for falsy input', () => {
    expect(cloneAndSanitizeBeetsMeta(null)).toBeNull();
    expect(cloneAndSanitizeBeetsMeta(undefined)).toBeNull();
  });

  it('returns null for object that becomes empty after pruning', () => {
    expect(cloneAndSanitizeBeetsMeta({ a: '', b: '  ' })).toBeNull();
  });
});

describe('hydrateTrackRecord', () => {
  const mockRadialSearch = {
    kdTree: {
      getTrack: jest.fn(id => id === 'known-id' ? {
        identifier: 'known-id',
        title: 'Test Track',
        artist: 'Test Artist',
        album: 'Test Album',
        path: '/test/path.mp3',
        length: 240,
        features: { bpm: 120 },
        pca: { tonal: [0.5, 0.3, 0.1] }
      } : null)
    }
  };

  beforeEach(() => {
    mockRadialSearch.kdTree.getTrack.mockClear();
  });

  it('returns hydrated track from KD-tree lookup', () => {
    const result = hydrateTrackRecord(mockRadialSearch, { identifier: 'known-id' });
    expect(result.identifier).toBe('known-id');
    expect(result.title).toBe('Test Track');
    expect(result.artist).toBe('Test Artist');
    expect(result.path).toBe('/test/path.mp3');
    expect(result.features).toEqual({ bpm: 120 });
    expect(mockRadialSearch.kdTree.getTrack).toHaveBeenCalledWith('known-id');
  });

  it('looks up by string identifier', () => {
    const result = hydrateTrackRecord(mockRadialSearch, 'known-id');
    expect(result.identifier).toBe('known-id');
    expect(result.title).toBe('Test Track');
    expect(mockRadialSearch.kdTree.getTrack).toHaveBeenCalledWith('known-id');
  });

  it('returns null for null input without annotations', () => {
    const result = hydrateTrackRecord(mockRadialSearch, null);
    expect(result).toBeNull();
  });

  it('returns minimal object for unknown identifier', () => {
    const result = hydrateTrackRecord(mockRadialSearch, 'unknown-id');
    expect(result.identifier).toBe('unknown-id');
    expect(mockRadialSearch.kdTree.getTrack).toHaveBeenCalledWith('unknown-id');
  });

  it('merges annotations over base track data', () => {
    const result = hydrateTrackRecord(
      mockRadialSearch,
      { identifier: 'known-id' },
      { title: 'Override Title' }
    );
    expect(result.title).toBe('Override Title');
    expect(result.artist).toBe('Test Artist');
  });
});

describe('getAdjustedTrackDuration', () => {
  it('uses track.length when mixer is not available', () => {
    const track = { identifier: 'abc', length: 300 };
    const result = getAdjustedTrackDuration(track, null, undefined, { logging: false });
    expect(result).toBe(300);
  });

  it('prefers mixer duration when mixer matches current track', () => {
    const track = { identifier: 'abc', length: 300 };
    const audioMixer = {
      getStatus: () => ({
        currentTrack: {
          identifier: 'abc',
          estimatedDuration: 295.5
        }
      })
    };
    const result = getAdjustedTrackDuration(track, audioMixer, undefined, { logging: false });
    expect(result).toBe(295.5);
  });

  it('falls back to track.length when mixer has different track', () => {
    const currentTrack = { identifier: 'abc', length: 300 };
    const queryTrack = { identifier: 'xyz', length: 200 };
    const audioMixer = {
      getStatus: () => ({
        currentTrack: {
          identifier: 'abc',
          estimatedDuration: 295.5
        }
      })
    };
    const result = getAdjustedTrackDuration(currentTrack, audioMixer, queryTrack, { logging: false });
    expect(result).toBe(200);
  });

  it('returns 0 when no duration source available', () => {
    const result = getAdjustedTrackDuration(null, null, {}, { logging: false });
    expect(result).toBe(0);
  });
});
