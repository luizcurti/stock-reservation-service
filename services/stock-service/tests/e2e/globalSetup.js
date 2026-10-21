'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mysql2 = require('mysql2/promise');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// docker-compose.yml lives at the repo root (services/stock-service is one level below it)
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');

// For schema management, always connect as root (root can CREATE DATABASE and GRANT)
const ROOT_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: 'root',
  password: process.env.DB_PASSWORD || 'root',
};

// Use dedicated test database — never touches the 'stock' dev database
const DB_NAME = 'stock_test';

async function waitForMySQL(maxAttempts = 60, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const conn = await mysql2.createConnection(ROOT_CONFIG);
      await conn.query('SELECT 1');
      await conn.end();
      console.log('  MySQL is ready!');
      return;
    } catch {
      console.log(`  Waiting for MySQL... (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('MySQL did not become available within the timeout.');
}

async function ensureTestDatabase() {
  const conn = await mysql2.createConnection(ROOT_CONFIG);
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    // Grant app_user full access to the test database (only needed once)
    const appUser = process.env.DB_USER || 'app_user';
    try {
      await conn.query(
        `GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${appUser}'@'%'`
      );
      await conn.query('FLUSH PRIVILEGES');
    } catch {
      // app_user may not exist yet if MySQL is still initializing — safe to ignore
    }
    console.log(`  Database '${DB_NAME}' ready.`);
  } finally {
    await conn.end();
  }
}

// The single source of truth for the schema is SQL/stock.sql (also what
// docker-compose and scripts/mesh/deploy.sh load). Only its CREATE TABLE
// statements are used here, as CREATE TABLE IF NOT EXISTS: the file also
// drops tables, seeds rows and targets the `stock` database, none of which
// the test database wants.
const SCHEMA_FILE = path.resolve(__dirname, '../../SQL/stock.sql');

function createTableStatements() {
  const sql = fs
    .readFileSync(SCHEMA_FILE, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => /^CREATE TABLE /i.test(stmt))
    .map((stmt) => stmt.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS '));
  if (statements.length === 0) {
    throw new Error(`No CREATE TABLE statements found in ${SCHEMA_FILE}`);
  }
  return statements;
}

async function ensureSchema() {
  const conn = await mysql2.createConnection({ ...ROOT_CONFIG, database: DB_NAME });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const statement of createTableStatements()) {
      await conn.query(statement);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('  Schema ready.');
  } finally {
    await conn.end();
  }
}

module.exports = async function globalSetup() {
  console.log('\n[E2E] Starting MySQL via docker compose...');

  const up = spawnSync('docker', ['compose', 'up', '-d', 'mysql_database'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });

  if (up.status !== 0) {
    // Fallback for older Docker installations
    const upLegacy = spawnSync('docker-compose', ['up', '-d', 'mysql_database'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
    if (upLegacy.status !== 0) {
      throw new Error('Failed to start docker compose. Make sure Docker is running.');
    }
  }

  console.log('[E2E] Waiting for MySQL...');
  await waitForMySQL();

  console.log('[E2E] Preparing test database...');
  await ensureTestDatabase();
  await ensureSchema();

  console.log('[E2E] Environment ready.\n');
};
