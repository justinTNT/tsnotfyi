const fs = require('fs');
const path = require('path');
const {
  normalizeNowPlayingSession,
  normalizeHeartbeatEvent
} = require('../../utils/normalizeContracts');

const CASES = [
  {
    schema: 'now_playing_session',
    normalize: normalizeNowPlayingSession
  },
  {
    schema: 'heartbeat_event',
    normalize: normalizeHeartbeatEvent
  }
];

function loadFixture(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (raw && typeof raw === 'object' && raw._notes) {
    delete raw._notes;
  }
  return raw;
}

describe('contract normalization golden tests', () => {
  CASES.forEach(({ schema, normalize }) => {
    const fixturesDir = path.join(__dirname, '../../fixtures', schema, 'valid');
    const goldenDir = path.join(__dirname, schema);

    const fixtureFiles = fs.readdirSync(fixturesDir).filter((file) => file.endsWith('.json'));

    fixtureFiles.forEach((fixtureName) => {
      test(`${schema} :: ${fixtureName}`, () => {
        const input = loadFixture(path.join(fixturesDir, fixtureName));
        const normalized = normalize(input);
        const golden = JSON.parse(
          fs.readFileSync(path.join(goldenDir, fixtureName), 'utf8')
        );
        expect(normalized).toEqual(golden);
      });
    });
  });
});
