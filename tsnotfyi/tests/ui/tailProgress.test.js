describe('tail progress behaviour', () => {
  const getHooks = () => {
    if (!global.__progressTestHooks) {
      throw new Error('Progress test hooks not registered');
    }
    return global.__progressTestHooks;
  };

  const callStopAnimation = () => {
    const hooks = getHooks();
    const stop =
      (typeof hooks.stopProgressAnimation === 'function' && hooks.stopProgressAnimation) ||
      (typeof window.stopProgressAnimation === 'function' && window.stopProgressAnimation);
    if (stop) {
      stop();
    }
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    callStopAnimation();
    const hooks = getHooks();
    hooks.state.tailProgress = 0;
    document.documentElement.classList.remove('tail-active', 'tail-complete');
    document.documentElement.style.removeProperty('--tail-progress');
  });

  afterEach(() => {
    callStopAnimation();
    jest.useRealTimers();
  });

  test('deck stays unlocked until tail completion', () => {
    const hooks = getHooks();
    const start =
      hooks.startProgressAnimationFromPosition ||
      window.startProgressAnimationFromPosition ||
      (window.__progressFns && window.__progressFns.start);
    expect(typeof start).toBe('function');
    const { state } = hooks;

    // Start 30s from the end, so tail animation is active
    start(120, 90);
    expect(state.tailProgress).toBe(0);
    expect(document.documentElement.classList.contains('tail-active')).toBe(false);

    jest.advanceTimersByTime(15_000); // halfway through the tail window
    expect(state.tailProgress).toBeGreaterThan(0.45);
    expect(document.documentElement.classList.contains('tail-active')).toBe(true);
    expect(document.querySelector('.dimension-card.interaction-locked')).toBeNull();

    jest.advanceTimersByTime(28_500); // almost complete
    expect(state.tailProgress).toBeGreaterThanOrEqual(0.95);
    expect(document.documentElement.classList.contains('tail-complete')).toBe(true);
    // At completion the deck should be in the tail-complete state; interaction lock is optional
  });

  test('starting a fresh track resets tail progress', () => {
    const hooks = getHooks();
    const start =
      hooks.startProgressAnimationFromPosition ||
      window.startProgressAnimationFromPosition ||
      (window.__progressFns && window.__progressFns.start);
    expect(typeof start).toBe('function');
    const { state } = hooks;

    start(60, 50);
    jest.advanceTimersByTime(12_000);
    expect(state.tailProgress).toBeGreaterThan(0.6);

    // New track begins
    start(180, 0);
    expect(state.tailProgress).toBe(0);
    expect(document.querySelector('.dimension-card.interaction-locked')).toBeNull();
    expect(document.documentElement.classList.contains('tail-active')).toBe(false);

    callStopAnimation();
    expect(document.documentElement.classList.contains('tail-active')).toBe(false);
    expect(document.documentElement.classList.contains('tail-complete')).toBe(false);
    expect(
      document.documentElement.style.getPropertyValue('--tail-progress') === '' ||
      document.documentElement.style.getPropertyValue('--tail-progress') === '0.000'
    ).toBe(true);
  });
});
