/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/e2e/**/*.e2e.spec.ts'],
  // Load .env BEFORE test modules are imported (so db pool uses correct creds)
  setupFiles: ['<rootDir>/tests/e2e/envSetup.ts'],
  // globalSetup/Teardown run in Jest master process — must be plain .js
  globalSetup: '<rootDir>/tests/e2e/globalSetup.js',
  globalTeardown: '<rootDir>/tests/e2e/globalTeardown.js',
  testTimeout: 30000,
  collectCoverage: false,
  // Force exit even if DB pool connections stay open
  forceExit: true,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: './tsconfig.json' }],
  },
};
