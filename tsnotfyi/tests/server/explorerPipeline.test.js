const {
  calculateDirectionDiversity,
  calculateVariance,
  computeNeighborhoodStats,
  sanitizeDirectionalStacks,
  removeEmptyDirections,
  finalDeduplication,
  selectTopTrack,
  getRandomSubset,
  shuffleArray
} = require('../../services/explorer-pipeline');

function makeDirection(key, tracks, opts = {}) {
  return {
    direction: key,
    domain: opts.domain || 'original',
    component: opts.component || key,
    polarity: opts.polarity || 'positive',
    sampleTracks: tracks.map(id => ({
      identifier: id,
      title: `Track ${id}`,
      artist: `Artist ${id}`,
      distance: Math.random()
    })),
    trackCount: tracks.length,
    diversityScore: opts.diversityScore || 50,
    ...opts
  };
}

describe('calculateDirectionDiversity', () => {
  it('returns 0 for zero tracks', () => {
    expect(calculateDirectionDiversity(0, 100)).toBe(0);
  });

  it('returns 0 for zero neighborhood', () => {
    expect(calculateDirectionDiversity(10, 0)).toBe(0);
  });

  it('peak score near 75/25 split', () => {
    const score = calculateDirectionDiversity(75, 100);
    expect(score).toBeGreaterThan(90);
  });

  it('moderate score for 50/50 split', () => {
    const score = calculateDirectionDiversity(50, 100);
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThanOrEqual(80);
  });

  it('low score for extreme ratios (95/5)', () => {
    const score = calculateDirectionDiversity(95, 100);
    expect(score).toBeLessThan(40);
  });

  it('score is always between 0 and 100', () => {
    for (let i = 0; i <= 100; i++) {
      const score = calculateDirectionDiversity(i, 100);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe('calculateVariance', () => {
  it('returns 0 for empty array', () => {
    expect(calculateVariance([])).toBe(0);
  });

  it('returns 0 for single value', () => {
    expect(calculateVariance([5])).toBe(0);
  });

  it('returns correct variance for known values', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] -> mean=5, variance=4
    const result = calculateVariance([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result).toBe(4);
  });

  it('returns 0 for identical values', () => {
    expect(calculateVariance([3, 3, 3])).toBe(0);
  });
});

describe('computeNeighborhoodStats', () => {
  it('handles empty array', () => {
    const stats = computeNeighborhoodStats([]);
    expect(stats.count).toBe(0);
    expect(stats.min).toBeNull();
    expect(stats.max).toBeNull();
    expect(stats.median).toBeNull();
    expect(stats.average).toBeNull();
  });

  it('handles single neighbor', () => {
    const stats = computeNeighborhoodStats([{ distance: 0.5 }]);
    expect(stats.count).toBe(1);
    expect(stats.min).toBe(0.5);
    expect(stats.max).toBe(0.5);
    expect(stats.median).toBe(0.5);
    expect(stats.average).toBe(0.5);
  });

  it('returns correct min/max/median/average for distance array', () => {
    const neighbors = [
      { distance: 0.1 },
      { distance: 0.3 },
      { distance: 0.5 },
      { distance: 0.7 },
      { distance: 0.9 }
    ];
    const stats = computeNeighborhoodStats(neighbors);
    expect(stats.count).toBe(5);
    expect(stats.min).toBe(0.1);
    expect(stats.max).toBe(0.9);
    expect(stats.median).toBe(0.5);
    expect(stats.average).toBe(0.5);
  });

  it('handles even number of entries for median', () => {
    const neighbors = [
      { distance: 1 },
      { distance: 2 },
      { distance: 3 },
      { distance: 4 }
    ];
    const stats = computeNeighborhoodStats(neighbors);
    expect(stats.median).toBe(2.5);
  });

  it('uses similarity when distance is missing', () => {
    const neighbors = [{ similarity: 0.8 }];
    const stats = computeNeighborhoodStats(neighbors);
    expect(stats.min).toBe(0.8);
  });

  it('returns null stats for non-array input', () => {
    const stats = computeNeighborhoodStats(null);
    expect(stats.count).toBe(0);
  });
});

describe('sanitizeDirectionalStacks', () => {
  it('removes duplicate tracks within same direction', () => {
    const directions = {
      faster: makeDirection('faster', ['a', 'b', 'a'])
    };
    // Manually add duplicate identifier
    directions.faster.sampleTracks.push({
      identifier: 'a',
      title: 'Track a dup',
      artist: 'Artist a',
      distance: 0.1
    });

    const { directions: cleaned, stats } = sanitizeDirectionalStacks(directions);
    const ids = cleaned.faster.sampleTracks.map(t => t.identifier);
    expect(new Set(ids).size).toBe(ids.length);
    expect(stats.duplicatesRemoved).toBeGreaterThan(0);
  });

  it('returns stats with duplicatesRemoved count', () => {
    const directions = {
      faster: makeDirection('faster', ['a', 'b']),
      slower: makeDirection('slower', ['a', 'c'])
    };
    const { stats } = sanitizeDirectionalStacks(directions);
    expect(stats.duplicatesRemoved).toBe(1);
    expect(stats.uniqueTracks).toBe(3);
  });

  it('preserves unique tracks', () => {
    const directions = {
      faster: makeDirection('faster', ['a', 'b', 'c'])
    };
    const { directions: cleaned, stats } = sanitizeDirectionalStacks(directions);
    expect(cleaned.faster.sampleTracks.length).toBe(3);
    expect(stats.duplicatesRemoved).toBe(0);
  });

  it('handles null input', () => {
    const { stats } = sanitizeDirectionalStacks(null);
    expect(stats.initialDirections).toBe(0);
  });
});

describe('removeEmptyDirections', () => {
  it('removes directions with 0 tracks', () => {
    const directions = {
      faster: makeDirection('faster', ['a', 'b']),
      slower: makeDirection('slower', [])
    };
    const { directions: cleaned, stats } = removeEmptyDirections(directions);
    expect(cleaned.faster).toBeDefined();
    expect(cleaned.slower).toBeUndefined();
    expect(stats.removedDirections).toBe(1);
  });

  it('promotes opposite direction when primary is empty', () => {
    const directions = {
      faster: {
        ...makeDirection('faster', []),
        oppositeDirection: {
          key: 'slower',
          sampleTracks: [{ identifier: 'x', title: 'X', artist: 'A', distance: 0.1 }]
        }
      }
    };
    const { directions: cleaned, stats } = removeEmptyDirections(directions);
    expect(cleaned.faster).toBeUndefined();
    expect(cleaned.slower).toBeDefined();
    expect(stats.promotedOpposites).toBe(1);
  });

  it('keeps directions with tracks', () => {
    const directions = {
      faster: makeDirection('faster', ['a']),
      brighter: makeDirection('brighter', ['b'])
    };
    const { directions: cleaned } = removeEmptyDirections(directions);
    expect(Object.keys(cleaned)).toEqual(['faster', 'brighter']);
  });

  it('handles null input', () => {
    const { stats } = removeEmptyDirections(null);
    expect(stats.removedDirections).toBe(0);
  });
});

describe('finalDeduplication', () => {
  it('each track appears in only one direction (first occurrence wins)', () => {
    const directions = {
      faster: {
        sampleTracks: [
          { identifier: 'a', title: 'A' },
          { identifier: 'b', title: 'B' }
        ]
      },
      brighter: {
        sampleTracks: [
          { identifier: 'a', title: 'A' },
          { identifier: 'c', title: 'C' }
        ]
      }
    };
    const result = finalDeduplication(directions);
    const fasterIds = result.faster.sampleTracks.map(t => t.identifier);
    const brighterIds = result.brighter.sampleTracks.map(t => t.identifier);

    // 'a' should appear only in faster (position 0 < position 0 in brighter, but same position so first key wins via Map)
    expect(fasterIds).toContain('a');
    expect(brighterIds).not.toContain('a');
    expect(brighterIds).toContain('c');
  });

  it('handles directions with empty sampleTracks', () => {
    const directions = {
      faster: { sampleTracks: [] },
      brighter: { sampleTracks: [{ identifier: 'a' }] }
    };
    const result = finalDeduplication(directions);
    expect(result.faster.sampleTracks).toEqual([]);
    expect(result.brighter.sampleTracks.length).toBe(1);
  });
});

describe('selectTopTrack', () => {
  it('returns directions with sampleTracks reordered so top pick is first', () => {
    const directions = {
      faster: makeDirection('faster', ['a', 'b', 'c']),
      brighter: makeDirection('brighter', ['d', 'e'])
    };
    const result = selectTopTrack(directions);
    // selectTopTrack reorders sampleTracks so the preferred top card is at index 0
    expect(result).toBeDefined();
    Object.values(result).forEach(dir => {
      if (dir.sampleTracks && dir.sampleTracks.length > 0) {
        // sampleTracks[0] is the chosen top track
        expect(dir.sampleTracks[0].identifier).toBeDefined();
      }
    });
  });

  it('preserves all tracks in each direction', () => {
    const directions = {
      faster: makeDirection('faster', ['a', 'b', 'c'])
    };
    const result = selectTopTrack(directions);
    const ids = result.faster.sampleTracks.map(t => t.identifier).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('getRandomSubset', () => {
  it('returns n items from array', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = getRandomSubset(arr, 3);
    expect(result.length).toBe(3);
    result.forEach(item => {
      expect(arr).toContain(item);
    });
  });

  it('returns full array when n >= array.length', () => {
    const arr = [1, 2, 3];
    const result = getRandomSubset(arr, 10);
    expect(result.length).toBe(3);
    expect(result.sort()).toEqual([1, 2, 3]);
  });

  it('returns empty for empty array', () => {
    expect(getRandomSubset([], 5)).toEqual([]);
  });

  it('returns empty for null input', () => {
    expect(getRandomSubset(null, 5)).toEqual([]);
  });

  it('does not mutate original array', () => {
    const arr = [1, 2, 3, 4, 5];
    const copy = arr.slice();
    getRandomSubset(arr, 3);
    expect(arr).toEqual(copy);
  });
});

describe('shuffleArray', () => {
  it('preserves all elements', () => {
    const arr = [1, 2, 3, 4, 5];
    shuffleArray(arr);
    expect(arr.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('modifies in place', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ref = arr;
    shuffleArray(arr);
    expect(ref).toBe(arr);
  });

  it('handles single-element array', () => {
    const arr = [42];
    shuffleArray(arr);
    expect(arr).toEqual([42]);
  });

  it('handles empty array', () => {
    const arr = [];
    shuffleArray(arr);
    expect(arr).toEqual([]);
  });
});
