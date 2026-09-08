/**
 * Loaded via jest.e2e.config.js setupFiles — runs inside each test worker
 * BEFORE any test module is imported. This ensures process.env is populated
 * with test DB credentials when database.ts creates the pool.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load the base .env (keeps dev credentials intact)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Use a dedicated test database so development data in 'stock' is never touched
process.env.DB_NAME = 'stock_test';
