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
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
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
