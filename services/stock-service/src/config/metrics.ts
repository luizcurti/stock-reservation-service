import client from 'prom-client';
import { RowDataPacket } from 'mysql2';
import { db } from './database';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});

export const rateLimitRejections = new client.Counter({
  name: 'rate_limit_rejections_total',
  help: 'Requests rejected by the rate limiter',
  registers: [registry],
});

export const reservationsReleased = new client.Counter({
  name: 'reservations_released_total',
  help: 'Expired reservations released back to stock by the cleanup scheduler',
  registers: [registry],
});

interface CountRow extends RowDataPacket {
  count: number;
}

// Queried on each scrape rather than tracked in-process: with multiple
// cluster workers/replicas each holding its own in-memory counter, only the
// database has a single true count of reservations actually outstanding.
new client.Gauge({
  name: 'reservations_active',
  help: 'Reservations currently held (not yet sold or returned)',
  registers: [registry],
  async collect(this: client.Gauge): Promise<void> {
    const [rows] = await db.query<CountRow[]>(
      'SELECT COUNT(*) as count FROM RESERVED'
    );
    this.set(rows[0]?.count ?? 0);
  },
});
