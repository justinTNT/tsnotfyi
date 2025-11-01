const fs = require('fs');
const path = require('path');
const { normalizers } = require('../../utils/normalizeContracts');

const CONTRACT_DIR = path.join(__dirname, '../../contracts');
const FIXTURE_DIR = path.join(__dirname, '../../fixtures');
const GOLDEN_DIR = path.join(__dirname, '../golden');

function readContract(file) {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, file), 'utf8'));
}

function listJsonFiles(dir) {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((file) => file.endsWith('.json'))
    : [];
}

describe('contract structure consistency', () => {
  const contractFiles = fs.readdirSync(CONTRACT_DIR).filter((file) => file.endsWith('.yaml'));

  test('every contract has a registered normalizer', () => {
    contractFiles.forEach((file) => {
      const base = path.basename(file, '.yaml');
      expect(typeof normalizers[base]).toBe('function');
    });
  });

  test('fixtures and golden traces exist for each contract', () => {
    contractFiles.forEach((file) => {
      const base = path.basename(file, '.yaml');
      const validDir = path.join(FIXTURE_DIR, base, 'valid');
      const invalidDir = path.join(FIXTURE_DIR, base, 'invalid');
      const goldenDir = path.join(GOLDEN_DIR, base);

      const validFixtures = listJsonFiles(validDir);
      const invalidFixtures = listJsonFiles(invalidDir);

      expect(validFixtures.length).toBeGreaterThanOrEqual(3);
      expect(invalidFixtures.length).toBeGreaterThanOrEqual(3);
      expect(fs.existsSync(goldenDir)).toBe(true);

      validFixtures.forEach((fixtureName) => {
        const goldenPath = path.join(goldenDir, fixtureName);
        expect(fs.existsSync(goldenPath)).toBe(true);
      });

      // Ensure fixture schema fields documented
      const contract = readContract(file);
      const fieldCount = Object.keys(contract.fields || {}).length;
      expect(fieldCount).toBeGreaterThan(0);
    });
  });
});
