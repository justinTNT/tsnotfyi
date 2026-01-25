jest.mock('../../directional-drift-player', () => {
  return jest.fn().mockImplementation(() => ({
    currentDirection: null,
    setCurrentDirection: jest.fn()
  }));
});

jest.mock('../../advanced-audio-mixer', () => {
  return jest.fn().mockImplementation(() => ({
    engine: {
      isCrossfading: false
    }
  }));
});

jest.mock('../../fingerprint-registry', () => ({
  touch: jest.fn(),
  ensureFingerprint: jest.fn(() => 'fp'),
  getFingerprintForSession: jest.fn(() => 'fp')
}));

const DriftAudioMixer = require('../../drift-audio-mixer');

function buildMixer() {
  const mixer = new DriftAudioMixer('session-test', {
    initialize: jest.fn()
  });
  mixer.clients = new Set(['client']);
  mixer.eventClients = new Set([{ emit: jest.fn() }]);
  mixer.broadcastHeartbeat = jest.fn(() => Promise.resolve());
  mixer.broadcastSelectionEvent = jest.fn();
  mixer.prepareNextTrackForCrossfade = jest.fn(() => Promise.resolve());
  mixer.applyUserSelectedTrackOverride = jest.fn(() => Promise.resolve());
  return mixer;
}

describe('manual selection guard rails', () => {
  test('does not clear next-track buffer while crossfade is active', async () => {
    const mixer = buildMixer();
    mixer.nextTrack = { identifier: 'auto-track' };
    mixer.audioMixer = {
      getStatus: jest
        .fn()
        .mockReturnValueOnce({ isCrossfading: true })
        .mockReturnValue({ isCrossfading: false }),
      clearNextTrackSlot: jest.fn()
    };

    await mixer.handleUserSelectedNextTrack('manual-track', { debounceMs: 0 });

    expect(mixer.audioMixer.clearNextTrackSlot).not.toHaveBeenCalled();
    expect(mixer.nextTrack).toEqual({ identifier: 'auto-track' });
    expect(mixer.applyUserSelectedTrackOverride).toHaveBeenCalledWith('manual-track');
  });

  test('clears next-track buffer immediately when no crossfade is running', async () => {
    const mixer = buildMixer();
    mixer.nextTrack = { identifier: 'auto-track' };
    mixer.audioMixer = {
      getStatus: jest.fn().mockReturnValue({ isCrossfading: false }),
      clearNextTrackSlot: jest.fn()
    };

    await mixer.handleUserSelectedNextTrack('manual-track', { debounceMs: 0 });

    expect(mixer.audioMixer.clearNextTrackSlot).toHaveBeenCalledTimes(1);
    expect(mixer.nextTrack).toBeNull();
    expect(mixer.applyUserSelectedTrackOverride).toHaveBeenCalledWith('manual-track');
  });
});
