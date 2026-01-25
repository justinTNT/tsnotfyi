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
    if (typeof hooks.stopProgressAnimation === 'function') {
      hooks.stopProgressAnimation();
    } else if (typeof window.stopProgressAnimation === 'function') {
      window.stopProgressAnimation();
    }

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
    if (typeof hooks.stopProgressAnimation === 'function') {
      hooks.stopProgressAnimation();
    } else if (typeof window.stopProgressAnimation === 'function') {
      window.stopProgressAnimation();
    }
    jest.useRealTimers();
  });

  test('clock advances while the wipe animates', () => {
    const hooks = getHooks();
    const start =
      hooks.startProgressAnimationFromPosition ||
      window.startProgressAnimationFromPosition ||
      (window.__progressFns && window.__progressFns.start);
    expect(typeof start).toBe('function');
    const elements = {
      progressWipe: document.getElementById('progressWipe'),
      playbackClock: document.getElementById('playbackClock')
    };

    start(120, 0);

    jest.advanceTimersByTime(30_000);
    expect(hooks.state.playbackStartTimestamp).not.toBeNull();
    expect(elements.progressWipe.style.width).not.toBe('0%');
  });

  test('clock remains visible after resync near the Danger Zone', () => {
    const hooks = getHooks();
    const start =
      hooks.startProgressAnimationFromPosition ||
      window.startProgressAnimationFromPosition ||
      (window.__progressFns && window.__progressFns.start);
    expect(typeof start).toBe('function');
    const { state } = hooks;
    const elements = {
      progressWipe: document.getElementById('progressWipe'),
      playbackClock: document.getElementById('playbackClock')
    };

    start(120, 88);

    jest.advanceTimersByTime(10_000);
    expect(hooks.state.playbackStartTimestamp).not.toBeNull();

    // Simulate SSE resync that keeps progress animation running
    jest.setSystemTime(new Date('2024-01-01T00:01:01Z'));
    start(120, 92, { resync: true });

    jest.advanceTimersByTime(10_000);
    expect(hooks.state.playbackStartTimestamp).not.toBeNull();
    expect(elements.progressWipe.style.width).not.toBe('0%');
  });
});
