// Jest setup file
import 'dotenv/config';

// This file is loaded before all tests run
// Configure global test environment here if needed

// Suppress console.error during tests to avoid noise unless needed for debugging
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = jest.fn();
});

afterEach(() => {
  console.error = originalConsoleError;
});

// Global test timeout
jest.setTimeout(10000);
