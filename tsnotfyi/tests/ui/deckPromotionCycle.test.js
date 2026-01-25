const DIRECTION_KEYS = [
  'bpm_negative',
  'danceability_positive',
  'tonal_clarity_negative',
  'spectral_centroid_positive',
  'tuning_purity_negative',
  'beat_punch_positive'
];

async function waitForDeckApi(maxAttempts = 15) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (window.__deckTestHooks && typeof window.__deckTestHooks.getDeckApi === 'function') {
      return window.__deckTestHooks.getDeckApi();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Deck API not ready');
}

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

async function initializeDeck(directionKeys) {
  jest.useRealTimers();
  await new Promise(resolve => setTimeout(resolve, 0));
  jest.useFakeTimers();

  const deckApi = await waitForDeckApi();
  const explorerData = buildExplorerData(directionKeys);
  window.state.latestExplorerData = JSON.parse(JSON.stringify(explorerData));

  await deckApi.createDimensionCards(window.state.latestExplorerData, {
    forceRedraw: true,
    skipExitAnimation: true
  });
  jest.advanceTimersByTime(250);
  return deckApi;
}

function canonicalDirectionKey(key) {
  return typeof window.resolveCanonicalDirectionKey === 'function'
    ? window.resolveCanonicalDirectionKey(key)
    : key;
}

function findCardForDirection(directionKey) {
  const canonicalKey = canonicalDirectionKey(directionKey);
  return Array.from(document.querySelectorAll('.dimension-card')).find(card => {
    const key = card.dataset.baseDirectionKey || card.dataset.directionKey;
    return key === canonicalKey || key === directionKey;
  }) || null;
}

function sampleTrackFor(directionKey) {
  return window.state.latestExplorerData?.directions?.[directionKey]?.sampleTracks?.[0]?.track || null;
}

function buildExplorerData(directionKeys) {
  const directions = {};
  directionKeys.forEach((key, idx) => {
    directions[key] = makeDirection(key, idx);
  });
  const firstKey = directionKeys[0];
  const nextTrack = {
    directionKey: firstKey,
    direction: directions[firstKey].direction,
    track: { ...directions[firstKey].sampleTracks[0].track }
  };
  return {
    directions,
    outliers: {},
    nextTrack,
    currentTrack: { ...window.state.latestCurrentTrack },
    resolution: 'magnifying'
  };
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
    window.state.directionKeyAliases = {};
    window.state.usingOppositeDirection = false;
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

  test('promoted direction cards render metadata in the center stack', async () => {
    const deckApi = await initializeDeck([
      'vae_latent_1_negative',
      'vae_latent_2_positive',
      'tonal_pc1_negative'
    ]);
    const { navigateDirectionToCenter } = deckApi;
    if (window.state.latestExplorerData) {
      window.state.latestExplorerData.nextTrack = null;
    }

    const directionKey = 'vae_latent_1_negative';
    const sampleTrack = sampleTrackFor(directionKey);
    expect(sampleTrack).not.toBeNull();

    navigateDirectionToCenter(directionKey);
    jest.advanceTimersByTime(1200);

    const centerCard = document.querySelector('.dimension-card.next-track');
    expect(centerCard).not.toBeNull();
    expect(centerCard.dataset.directionKey).toBe(canonicalDirectionKey(directionKey));
    const labelText = centerCard.querySelector('.dimension-label')?.textContent || centerCard.textContent || '';
    expect(labelText).toContain(sampleTrack.title);
  });

  test('demoted direction cards regain their deck identity when selecting a new direction', async () => {
    const deckApi = await initializeDeck([
      'vae_latent_1_negative',
      'vae_latent_2_positive',
      'tonal_pc1_negative'
    ]);
    const { navigateDirectionToCenter } = deckApi;
    if (window.state.latestExplorerData) {
      window.state.latestExplorerData.nextTrack = null;
    }

    const firstKey = 'vae_latent_1_negative';
    const secondKey = 'vae_latent_2_positive';
    const firstSample = sampleTrackFor(firstKey);
    expect(firstSample).not.toBeNull();

    navigateDirectionToCenter(firstKey);
    jest.advanceTimersByTime(1200);
    navigateDirectionToCenter(secondKey);
    jest.advanceTimersByTime(1200);

    const demotedCard = findCardForDirection(firstKey);
    expect(demotedCard).not.toBeNull();
    expect(demotedCard.classList.contains('next-track')).toBe(false);
    const label = demotedCard.querySelector('.dimension-label');
    expect(label).not.toBeNull();
    expect(label.textContent).toContain(firstSample.title);
  });

  test('collapses duplicate polarity directions into a single deck card', async () => {
    jest.useRealTimers();
    await new Promise(resolve => setTimeout(resolve, 0));
    jest.useFakeTimers();

    const deckApi = await waitForDeckApi();
    const { createDimensionCards } = deckApi;

    const directionKeys = [
      'vae_latent_7_negative',
      'vae_latent_7_positive',
      'tonal_pc1_positive'
    ];

    const explorerData = buildExplorerData(directionKeys);
    window.state.latestExplorerData = JSON.parse(JSON.stringify(explorerData));

    await createDimensionCards(window.state.latestExplorerData, {
      forceRedraw: true,
      skipExitAnimation: true
    });
    const aliasMapSnapshot = { ...(window.state.directionKeyAliases || {}) };
    jest.advanceTimersByTime(250);

    const allCards = Array.from(document.querySelectorAll('.dimension-card'));
    const midnightCards = allCards.filter(card =>
      (card.dataset.directionKey || '').startsWith('vae_latent_7')
    );

    expect(midnightCards).toHaveLength(1);

    expect(aliasMapSnapshot.vae_latent_7_negative).toBe(midnightCards[0].dataset.directionKey);
  });

  test('server heartbeat realigns the next-track card after a manual promotion', async () => {
    const directionKeys = [
      'vae_latent_1_negative',
      'vae_latent_2_positive',
      'tonal_pc1_positive'
    ];
    const deckApi = await initializeDeck(directionKeys);
    const { navigateDirectionToCenter } = deckApi;
    if (window.state.latestExplorerData) {
      window.state.latestExplorerData.nextTrack = null;
    }

    const manualDirection = 'vae_latent_1_negative';
    navigateDirectionToCenter(manualDirection);
    jest.advanceTimersByTime(1200);

    const heartbeatDirection = 'tonal_pc1_positive';
    const heartbeatTrack = sampleTrackFor(heartbeatDirection);
    expect(heartbeatTrack).not.toBeNull();

    window.state.manualNextTrackOverride = false;
    window.state.serverNextDirection = heartbeatDirection;
    window.state.serverNextTrack = heartbeatTrack.identifier;
    window.state.selectedIdentifier = heartbeatTrack.identifier;
    if (window.state.latestExplorerData) {
      window.state.latestExplorerData.nextTrack = {
        directionKey: heartbeatDirection,
        direction: window.state.latestExplorerData.directions[heartbeatDirection].direction,
        track: { ...heartbeatTrack }
      };
    }

    if (typeof window.convertToNextTrackStack === 'function') {
      window.convertToNextTrackStack(heartbeatDirection, { notifyServer: false });
    } else if (typeof window.refreshCardsWithNewSelection === 'function') {
      window.refreshCardsWithNewSelection();
    } else if (typeof deckApi.createDimensionCards === 'function') {
      await deckApi.createDimensionCards(window.state.latestExplorerData, {
        forceRedraw: true,
        skipExitAnimation: true
      });
    }
    jest.advanceTimersByTime(1200);

    const centerCard = document.querySelector('.dimension-card.next-track');
    expect(centerCard).not.toBeNull();
    expect(centerCard.dataset.directionKey).toBe(canonicalDirectionKey(heartbeatDirection));

    const manualCard = findCardForDirection(manualDirection);
    expect(manualCard).not.toBeNull();
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
