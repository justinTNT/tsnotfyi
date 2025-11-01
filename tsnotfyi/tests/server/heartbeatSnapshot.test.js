const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const DriftAudioMixer = require('../../drift-audio-mixer');
const { normalizeHeartbeatEvent } = require('../../utils/normalizeContracts');

jest.mock('../../fingerprint-registry', () => ({
  touch: jest.fn(),
  ensureFingerprint: jest.fn(() => 'fingerprint-mock'),
  getFingerprintForSession: jest.fn(() => 'fingerprint-mock')
}));

describe('DriftAudioMixer heartbeat + snapshot contracts', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createMixer(overrides = {}) {
    const mixer = new DriftAudioMixer('test-session', {
      exploreFromTrack: jest.fn()
    });
    mixer.clients = new Set(['client']);
    mixer.eventClients = new Set([new EventEmitter()]);
    mixer.currentTrack = overrides.currentTrack || {
      identifier: 'aaaabbbbccccddddeeeeffff11112222',
      title: 'Test Track',
      artist: 'Test Artist',
      length: 180
    };
    mixer.trackStartTime = overrides.trackStartTime || Date.now() - 30_000;
    mixer.nextTrack = overrides.nextTrack || {
      identifier: '9999aaaabbbbccccddddeeeeffff0000',
      title: 'Next Track',
      artist: 'Future Artist'
    };
    mixer.driftPlayer = {
      currentDirection: 'beat_punch_positive'
    };
    mixer.nextTrackLoadPromise = null;
    mixer.isUserSelectionPending = false;
    mixer.sessionHistory = [];
    mixer.broadcastEvent = jest.fn();
    return mixer;
  }

  function loadFixture(name) {
    const absolute = path.join(process.cwd(), 'fixtures', 'heartbeat_event', 'valid', name);
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  }

  test('heartbeat payload matches contract reference', async () => {
    const mixers = createMixer({ trackStartTime: Date.now() - 150_000 });

    await mixers.broadcastHeartbeat('user-next-prepared', { force: true });

    expect(mixers.broadcastEvent).toHaveBeenCalledTimes(1);
    const payload = mixers.broadcastEvent.mock.calls[0][0];

    const normalized = normalizeHeartbeatEvent(payload);
    expect(normalized).toMatchSnapshot('heartbeat-normalized');
  });
});
