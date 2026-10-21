/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.{ts,js}',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
    '!src/config/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  testMatch: ['**/tests/**/*.spec.ts', '**/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['<rootDir>/tests/e2e/'],
  modulePathIgnorePatterns: ['mockData'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  clearMocks: true,
  // Ensure mock implementations are reset between tests to avoid cross-test leakage
  resetMocks: true,
  restoreMocks: true,
};
