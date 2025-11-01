function buildDirection() {
  const makeTrack = (id, title) => ({
    identifier: id,
    title,
    artist: 'Test Artist',
    album: 'Test Album',
    duration: 180,
    albumCover: ''
  });

  const baseSamples = [
    { track: makeTrack('neg-track-1', 'Negative One') },
    { track: makeTrack('neg-track-2', 'Negative Two') }
  ];

  const oppositeSamples = [
    { track: makeTrack('pos-track-1', 'Positive One') },
    { track: makeTrack('pos-track-2', 'Positive Two') }
  ];

  const oppositeDirection = {
    key: 'bpm_positive',
    direction: 'faster',
    description: 'Tempo',
    domain: 'original',
    component: 'bpm',
    polarity: 'positive',
    trackCount: oppositeSamples.length,
    sampleTracks: oppositeSamples.map(sample => ({ track: { ...sample.track } })),
    hasOpposite: true
  };

  return {
    key: 'bpm_negative',
    direction: 'slower',
    description: 'Tempo',
    domain: 'original',
    component: 'bpm',
    polarity: 'negative',
    trackCount: baseSamples.length,
    sampleTracks: baseSamples.map(sample => ({ track: { ...sample.track } })),
    hasOpposite: true,
    oppositeDirection
  };
}

describe('direction reverse color synchronisation', () => {
  let card;

  beforeEach(() => {
    card = document.createElement('div');
    card.className = 'dimension-card next-track track-detail-card visible';
    document.getElementById('dimensionCards').appendChild(card);
  });

  afterEach(() => {
    card.remove();
    card = null;
  });

  test('opposite stack keeps rim and border colors aligned', () => {
    const direction = buildDirection();
    const baseTrack = direction.sampleTracks[0].track;
    const oppositeTrack = direction.oppositeDirection.sampleTracks[0].track;
    const alternateOpposite = direction.oppositeDirection.sampleTracks[1].track;

    window.state.latestExplorerData = {
      directions: {
        [direction.key]: direction
      },
      nextTrack: {
        directionKey: direction.key,
        track: baseTrack
      }
    };
    window.state.usingOppositeDirection = false;
    window.state.baseDirectionKey = direction.key;
    window.state.currentOppositeDirectionKey = direction.oppositeDirection.key;
    window.state.remainingCounts = {};
    window.state.selectedIdentifier = null;
    window.state.stackIndex = 0;

    window.updateCardWithTrackDetails(card, baseTrack, direction, false, () => {});

    const baseBorder = card.style.getPropertyValue('--border-color').trim();
    expect(baseBorder).toBeTruthy();
    expect(card.dataset.borderColor).toBe(baseBorder);

    const baseRim = card.querySelector('.rim').style.background.toLowerCase();
    expect(baseRim).toContain(baseBorder.toLowerCase());
    expect(baseRim).toContain('from 180deg');

    window.state.usingOppositeDirection = true;
    window.state.selectedIdentifier = oppositeTrack.identifier;
    window.state.latestExplorerData.nextTrack = {
      directionKey: direction.oppositeDirection.key,
      track: oppositeTrack
    };

    window.updateCardWithTrackDetails(card, oppositeTrack, direction.oppositeDirection, false, () => {});

    const oppositeBorder = card.style.getPropertyValue('--border-color').trim();
    expect(oppositeBorder).toBeTruthy();
    expect(card.dataset.borderColor).toBe(oppositeBorder);

    const oppositeRim = card.querySelector('.rim').style.background.toLowerCase();
    expect(oppositeRim).toContain(oppositeBorder.toLowerCase());
    expect(oppositeRim).not.toContain('from 180deg');

    const reverseButton = card.querySelector('.uno-reverse.next-track-reverse');
    expect(reverseButton).not.toBeNull();
    const reverseTop = reverseButton.style.getPropertyValue('--reverse-top-color');
    const reverseBottom = reverseButton.style.getPropertyValue('--reverse-bottom-color');
    const reverseAttr = reverseButton.getAttribute('style') || '';
    expect(reverseTop || reverseAttr).toContain(oppositeBorder);
    const reverseAccent = card.dataset.oppositeBorderColor;
    expect(reverseAccent).toBeTruthy();
    expect((reverseBottom || reverseAttr)).toContain(reverseAccent);

    window.updateCardWithTrackDetails(card, alternateOpposite, direction.oppositeDirection, true, () => {});

    const cycledBorder = card.style.getPropertyValue('--border-color').trim();
    expect(cycledBorder).toBe(oppositeBorder);

    const cycledRim = card.querySelector('.rim').style.background.toLowerCase();
    expect(cycledRim).toContain(cycledBorder.toLowerCase());

    const reverseAfterCycle = card.querySelector('.uno-reverse.next-track-reverse');
    expect(reverseAfterCycle).not.toBeNull();
    const styleAttr = reverseAfterCycle.getAttribute('style') || '';
    expect(styleAttr).toContain(cycledBorder);
  });

  test('reverse badge persists after repeated swaps', () => {
    const direction = buildDirection();
    const cloneSamples = (samples) => samples.map(sample => ({ track: { ...sample.track } }));

    const baseEntry = {
      ...direction,
      sampleTracks: cloneSamples(direction.sampleTracks),
      hasOpposite: true,
      oppositeDirection: {
        ...direction.oppositeDirection,
        hasOpposite: true,
        sampleTracks: cloneSamples(direction.oppositeDirection.sampleTracks)
      }
    };

    const oppositeEntry = {
      ...direction.oppositeDirection,
      sampleTracks: cloneSamples(direction.oppositeDirection.sampleTracks),
      hasOpposite: true,
      oppositeDirection: {
        key: direction.key,
        direction: direction.direction,
        hasOpposite: true,
        sampleTracks: cloneSamples(direction.sampleTracks)
      }
    };

    const baseTrack = baseEntry.sampleTracks[0].track;
    const oppositeTrack = oppositeEntry.sampleTracks[0].track;

    window.state.latestExplorerData = {
      directions: {
        [baseEntry.key]: baseEntry,
        [oppositeEntry.key]: oppositeEntry
      },
      nextTrack: {
        directionKey: baseEntry.key,
        direction: baseEntry.direction,
        track: { ...baseTrack }
      }
    };
    window.state.usingOppositeDirection = false;
    window.state.baseDirectionKey = baseEntry.key;
    window.state.currentOppositeDirectionKey = oppositeEntry.key;
    window.state.selectedIdentifier = baseTrack.identifier;
    window.state.lastSelectionGeneration = 1;
    window.state.pendingManualTrackId = null;
    window.state.serverNextTrack = null;
    window.state.stackIndex = 0;

    window.updateCardWithTrackDetails(card, baseTrack, baseEntry, false, window.swapStackContents);

    const initialReverse = card.querySelector('.uno-reverse.next-track-reverse');
    expect(initialReverse).not.toBeNull();
    expect(card.dataset.directionKey).toBe(baseEntry.key);
    expect(card.dataset.baseDirectionKey).toBe(baseEntry.key);
    expect(card.dataset.oppositeDirectionKey).toBe(oppositeEntry.key);

    window.swapStackContents(baseEntry.key, oppositeEntry.key);

    const afterSwapReverse = card.querySelector('.uno-reverse.next-track-reverse');
    expect(afterSwapReverse).not.toBeNull();
    expect(window.state.usingOppositeDirection).toBe(true);
    expect(card.dataset.directionKey).toBe(oppositeEntry.key);
    expect(card.dataset.baseDirectionKey).toBe(baseEntry.key);
    expect(card.dataset.oppositeDirectionKey).toBe(baseEntry.key);
    expect(window.state.latestExplorerData.directions[baseEntry.key].oppositeDirection.key).toBe(oppositeEntry.key);
    expect(window.state.latestExplorerData.directions[oppositeEntry.key].oppositeDirection.key).toBe(baseEntry.key);

    window.swapStackContents(oppositeEntry.key, baseEntry.key);

    const afterReturnReverse = card.querySelector('.uno-reverse.next-track-reverse');
    expect(afterReturnReverse).not.toBeNull();
    expect(window.state.usingOppositeDirection).toBe(false);
    expect(card.dataset.directionKey).toBe(baseEntry.key);
    expect(card.dataset.baseDirectionKey).toBe(baseEntry.key);
    expect(card.dataset.oppositeDirectionKey).toBe(oppositeEntry.key);
    expect(window.state.currentOppositeDirectionKey).toBe(oppositeEntry.key);
  });
});
