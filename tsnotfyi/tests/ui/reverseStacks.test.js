describe('reverse stack track selection', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  test('prioritizeAlternateTrack moves a new track to the front', () => {
    const hooks = window.__deckTestHooks;
    expect(hooks).toBeDefined();
    const prioritize = hooks.prioritizeAlternateTrack;
    expect(typeof prioritize).toBe('function');

    const sampleTracks = [
      { track: { identifier: 'shared', title: 'Shared Track' } },
      { track: { identifier: 'unique', title: 'Unique Track' } },
      { track: { identifier: 'another', title: 'Another Track' } }
    ];

    prioritize(sampleTracks, 'shared');

    expect(sampleTracks[0].track.identifier).toBe('unique');
    expect(sampleTracks[1].track.identifier).toBe('shared');
  });
});
