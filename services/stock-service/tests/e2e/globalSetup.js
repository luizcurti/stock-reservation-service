'use strict';

const { spawnSync } = require('child_process');
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

async function ensureSchema() {
  const conn = await mysql2.createConnection({ ...ROOT_CONFIG, database: DB_NAME });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`IN_STOCK\` (
        \`id\`         int          NOT NULL PRIMARY KEY,
        \`product\`    varchar(100) NOT NULL,
        \`qtd\`        int          NOT NULL DEFAULT 0,
        \`created_at\` timestamp    DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` timestamp    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`RESERVED\` (
        \`id\`               int          NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`id_stock\`         int          NOT NULL,
        \`product\`          varchar(100) NOT NULL,
        \`reservationToken\` varchar(100) NOT NULL,
        \`created_at\`       timestamp    DEFAULT CURRENT_TIMESTAMP,
        \`expires_at\`       timestamp    DEFAULT (DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 24 HOUR)),
        UNIQUE KEY \`uq_reserved_token\` (\`reservationToken\`),
        INDEX \`idx_id_stock\` (\`id_stock\`),
        FOREIGN KEY (\`id_stock\`) REFERENCES \`IN_STOCK\`(\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`SOLD\` (
        \`id\`               int          NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`id_stock\`         int          NOT NULL,
        \`product\`          varchar(100) NOT NULL,
        \`reservationToken\` varchar(100) NOT NULL,
        \`sold_at\`          timestamp    DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`uq_sold_token\` (\`reservationToken\`),
        INDEX \`idx_id_stock\` (\`id_stock\`),
        FOREIGN KEY (\`id_stock\`) REFERENCES \`IN_STOCK\`(\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

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
