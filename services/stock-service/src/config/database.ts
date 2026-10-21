import mysql, { PoolOptions } from 'mysql2';

const dbConfig: PoolOptions = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '3306', 10),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // DB_SSL=true encrypts the connection without verifying the server
  // certificate (no CA bundle shipped in the image) — for a managed database
  // reached inside a private network, e.g. RDS. Unset for docker-compose.
  ...(process.env.DB_SSL === 'true' && { ssl: { rejectUnauthorized: false } }),
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
};

const pool = mysql.createPool(dbConfig);
export const db = pool.promise();
