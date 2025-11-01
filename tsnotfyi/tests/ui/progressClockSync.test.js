describe('progress wipe and clock stay aligned', () => {
  const getHooks = () => {
    if (!global.__progressTestHooks) {
      throw new Error('Progress test hooks not registered');
    }
    return global.__progressTestHooks;
  };

  const INITIAL_TIME = new Date('2024-01-01T00:00:01Z');

  beforeEach(() => {
    jest.useFakeTimers({
      now: INITIAL_TIME,
      doNotFake: ['performance']
    });

    const hooks = getHooks();
    hooks.stopProgressAnimation();

    const progressWipe = document.getElementById('progressWipe');
    const playbackClock = document.getElementById('playbackClock');
    progressWipe.style.left = '0%';
    progressWipe.style.width = '0%';
    progressWipe.style.right = 'auto';
    playbackClock.textContent = '';
    playbackClock.classList.add('is-hidden');

    // Reset state timing
    hooks.state.playbackStartTimestamp = null;
    hooks.state.playbackDurationSeconds = 0;
  });

  afterEach(() => {
    const hooks = getHooks();
    hooks.stopProgressAnimation();
    jest.useRealTimers();
  });

  test('clock advances while the wipe animates', () => {
    const hooks = getHooks();
    const { startProgressAnimationFromPosition } = hooks;
    const elements = {
      progressWipe: document.getElementById('progressWipe'),
      playbackClock: document.getElementById('playbackClock')
    };

    startProgressAnimationFromPosition(120, 0);

    expect(elements.playbackClock.textContent).toBe('0:00');
    expect(elements.playbackClock.classList.contains('is-hidden')).toBe(false);

    jest.advanceTimersByTime(1_000);
    expect(elements.playbackClock.textContent).toBe('0:01');

    jest.advanceTimersByTime(29_000);
    expect(elements.playbackClock.textContent).toBe('0:30');
    expect(elements.playbackClock.classList.contains('is-hidden')).toBe(false);

    // Ensure wipe moved away from the origin
    expect(elements.progressWipe.style.width).not.toBe('0%');
  });

  test('clock remains visible after resync near midpoint', () => {
    const hooks = getHooks();
    const { startProgressAnimationFromPosition, state } = hooks;
    const elements = {
      progressWipe: document.getElementById('progressWipe'),
      playbackClock: document.getElementById('playbackClock')
    };

    startProgressAnimationFromPosition(120, 50);

    jest.advanceTimersByTime(500);
    expect(elements.playbackClock.classList.contains('is-hidden')).toBe(false);

    // Simulate SSE resync that keeps progress animation running
    jest.setSystemTime(new Date('2024-01-01T00:01:01Z'));
    startProgressAnimationFromPosition(120, 60, { resync: true });

    jest.advanceTimersByTime(500);
    expect(elements.playbackClock.classList.contains('is-hidden')).toBe(false);
    expect(elements.playbackClock.textContent).toBe('1:00');
    expect(state.playbackStartTimestamp).not.toBeNull();
  });
});
