module.exports = {
  detectOpenHandles: true,
  testTimeout: 15000,
  projects: [
    {
      displayName: 'api',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/server/**/*.test.js']
    },
    {
      displayName: 'ui',
      testEnvironment: 'jsdom',
      setupFilesAfterEnv: ['<rootDir>/tests/ui/setup.js'],
      testMatch: ['<rootDir>/tests/ui/**/*.test.js'],
      transform: {
        '^.+\\.js$': 'babel-jest'
      },
      transformIgnorePatterns: [
        '/node_modules/'
      ]
    }
  ]
};
