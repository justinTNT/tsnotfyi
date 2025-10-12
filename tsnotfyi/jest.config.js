module.exports = {
  projects: [
    {
      displayName: 'api',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/server/**/*.test.js']
    },
    {
      displayName: 'ui',
      testEnvironment: 'jsdom',
      setupFiles: ['<rootDir>/tests/ui/setup.js'],
      testMatch: ['<rootDir>/tests/ui/**/*.test.js']
    }
  ]
};
