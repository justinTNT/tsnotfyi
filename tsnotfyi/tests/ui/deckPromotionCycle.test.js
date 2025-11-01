const DIRECTION_KEYS = [
  'bpm_negative',
  'danceability_positive',
  'tonal_clarity_negative',
  'spectral_centroid_positive',
  'tuning_purity_negative',
  'beat_punch_positive'
];

function makeTrack(idSuffix, label) {
  return {
    identifier: `track-${idSuffix}`,
    title: label,
    artist: 'Test Artist',
    album: 'Test Album',
    duration: 180,
    albumCover: ''
  };
}

function makeDirection(key, index) {
  const sampleTrack = makeTrack(`${key}-${index}`, `${key} sample`);
  return {
    key,
    direction: key.replace(/_/g, ' '),
    description: `Direction ${key}`,
    domain: key.startsWith('spectral') ? 'spectral_pca' : 'original',
    component: key,
    polarity: key.includes('negative') ? 'negative' : 'positive',
    trackCount: 1,
    sampleTracks: [{ track: { ...sampleTrack } }],
    hasOpposite: false
  };
}

function flushTimersSafely(limit = 20) {
  let remaining = limit;
  while (jest.getTimerCount() > 0 && remaining > 0) {
    jest.runOnlyPendingTimers();
    remaining -= 1;
  }
  if (jest.getTimerCount() > 0) {
    // eslint-disable-next-line no-console
    console.warn('[deckPromotionCycle] timers still pending after flush', {
      timers: jest.getTimerCount()
    });
    jest.clearAllTimers();
  }
}

describe('deck promote/demote cycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllTimers();
    flushTimersSafely();
    const container = document.getElementById('dimensionCards');
    container.innerHTML = '';
    window.state.latestExplorerData = null;
    window.state.latestCurrentTrack = {
      identifier: 'current-track',
      title: 'Current Track',
      artist: 'Current Artist',
      duration: 200,
      albumCover: ''
    };
    window.state.cardsDormant = false;
    window.state.manualNextTrackOverride = false;
    window.state.pendingDeckHydration = false;
    if (typeof window.scheduleHeartbeat === 'function') {
      jest.spyOn(window, 'scheduleHeartbeat').mockImplementation(() => {});
    } else {
      window.scheduleHeartbeat = jest.fn();
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllTimers();
    window.state.manualNextTrackOverride = false;
    window.state.pendingDeckHydration = false;
    if (window.scheduleHeartbeat && window.scheduleHeartbeat.mock) {
      window.scheduleHeartbeat.mockRestore();
    }
  });

  // TODO(deck-cycle): Re-enable once selection realignment is test-friendly.
  // See docs/disabled-tests.md#deck-promotion-cycle for current context.
  test.skip('each direction card returns to its clock slot after promotion', () => {
    const directions = {};
    DIRECTION_KEYS.forEach((key, idx) => {
      directions[key] = makeDirection(key, idx);
    });

    const firstKey = DIRECTION_KEYS[0];
    const explorerData = {
      directions,
      outliers: {},
      nextTrack: {
        directionKey: firstKey,
        direction: directions[firstKey].direction,
        track: { ...directions[firstKey].sampleTracks[0].track }
      },
      currentTrack: {
        ...window.state.latestCurrentTrack
      },
      resolution: 'magnifying_glass'
    };

    window.state.latestExplorerData = explorerData;
    const refreshSelection = window.refreshCardsWithNewSelection;
    expect(typeof refreshSelection).toBe('function');

    const container = document.getElementById('dimensionCards');
    container.innerHTML = '';
    const initialPositions = new Map(
      DIRECTION_KEYS.map((key, idx) => {
        const card = document.createElement('div');
        card.className = 'dimension-card';
        card.dataset.directionKey = key;
        card.dataset.clockPosition = String(idx + 1);
        card.dataset.originalClockPosition = String(idx + 1);
        container.appendChild(card);
        return [key, card.dataset.clockPosition];
      })
    );

    let previousKey = null;

    DIRECTION_KEYS.forEach(directionKey => {
      const direction = directions[directionKey];
      const track = direction.sampleTracks[0].track;

      window.state.selectedIdentifier = track.identifier;
      window.state.manualNextTrackOverride = true;
      window.state.latestExplorerData.nextTrack = {
        directionKey,
        direction: direction.direction,
        track: { ...track }
      };

      refreshSelection();
      flushTimersSafely();

      const centerCard = container.querySelector('.dimension-card.next-track');
      expect(centerCard).not.toBeNull();
      expect(centerCard.dataset.directionKey).toBe(directionKey);
      expect(centerCard.querySelector('.panel')).not.toBeNull();
      expect(centerCard.querySelector('.rim')).not.toBeNull();

      if (previousKey) {
        const restoredCard = Array.from(container.querySelectorAll('.dimension-card'))
          .find(card => card.dataset.directionKey === previousKey && !card.classList.contains('next-track'));
        expect(restoredCard).toBeDefined();
        expect(restoredCard.dataset.clockPosition).toBe(initialPositions.get(previousKey));
      }

      previousKey = directionKey;
    });

    // The final direction remains promoted at the center; prior directions have all been restored.
  });
});
