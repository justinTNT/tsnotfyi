jest.mock('timers/promises', () => ({
  setImmediate: jest.fn(() => Promise.resolve())
}));

const { setImmediate: setImmediateSpy } = require('timers/promises');
const DriftAudioMixer = require('../../drift-audio-mixer');

function buildSampleTracks(key, count) {
  return Array.from({ length: count }, (_, idx) => ({
    identifier: `${key}-track-${idx}`,
    title: `${key} track ${idx}`,
    artist: 'Test Artist',
    duration: 180
  }));
}

function makeDirection({ key, direction, description, domain, component, polarity, trackCount, diversityScore, totalNeighborhoodSize }) {
  return {
    direction,
    description,
    domain,
    component,
    polarity,
    trackCount,
    totalNeighborhoodSize,
    diversityScore,
    isOutlier: false,
    splitRatio: trackCount / totalNeighborhoodSize,
    sampleTracks: buildSampleTracks(key, trackCount)
  };
}

function createDirectionSet() {
  const totalNeighborhoodSize = 100;
  const directions = {};

  const corePairs = [
    { base: 'bpm', description: 'Tempo' },
    { base: 'danceability', description: 'Danceability' },
    { base: 'spectral_centroid', description: 'Brightness' },
    { base: 'tonal_clarity', description: 'Tonality' }
  ];

  corePairs.forEach(({ base, description }, idx) => {
    const positiveKey = `${base}_positive`;
    const negativeKey = `${base}_negative`;
    directions[positiveKey] = makeDirection({
      key: positiveKey,
      direction: `more_${base}`,
      description,
      domain: 'original',
      component: base,
      polarity: 'positive',
      trackCount: 20 - idx,
      diversityScore: 4.5 + idx * 0.1,
      totalNeighborhoodSize
    });
    directions[negativeKey] = makeDirection({
      key: negativeKey,
      direction: `less_${base}`,
      description,
      domain: 'original',
      component: base,
      polarity: 'negative',
      trackCount: 18 - idx,
      diversityScore: 4.2 + idx * 0.1,
      totalNeighborhoodSize
    });
  });

  const pcaPairs = [
    { base: 'tonal_pc1', domain: 'tonal', component: 'pc1' },
    { base: 'tonal_pc2', domain: 'tonal', component: 'pc2' },
    { base: 'spectral_pc1', domain: 'spectral', component: 'pc1' },
    { base: 'spectral_pc2', domain: 'spectral', component: 'pc2' }
  ];

  pcaPairs.forEach(({ base, domain, component }, idx) => {
    const positiveKey = `${base}_positive`;
    const negativeKey = `${base}_negative`;
    directions[positiveKey] = makeDirection({
      key: positiveKey,
      direction: `${domain}_rise`,
      description: `${domain} up`,
      domain,
      component,
      polarity: 'positive',
      trackCount: 16 - idx,
      diversityScore: 3.8 + idx * 0.2,
      totalNeighborhoodSize
    });
    directions[negativeKey] = makeDirection({
      key: negativeKey,
      direction: `${domain}_fall`,
      description: `${domain} down`,
      domain,
      component,
      polarity: 'negative',
      trackCount: 14 - idx,
      diversityScore: 3.5 + idx * 0.2,
      totalNeighborhoodSize
    });
  });

  return directions;
}

describe('startup streaming resilience', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('explorer warmup yields control so audio streaming stays responsive', async () => {
    const mixer = new DriftAudioMixer('test-session', {});
    const directions = createDirectionSet();

    const result = await mixer.limitToTopDimensions(directions, 12);

    expect(setImmediateSpy).toHaveBeenCalled();
    expect(Object.keys(result).length).toBeLessThanOrEqual(12);
    expect(result).toHaveProperty('bpm_positive');
  });
});
