/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageThreshold: {
    global: { branches: 85, functions: 100, lines: 90, statements: 90 },
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: './tsconfig.test.json' }],
  },
};
