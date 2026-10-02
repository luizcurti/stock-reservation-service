import request from 'supertest';
import type { Express } from 'express';

// The limiter is configured when app.ts is loaded, so this suite loads its
// own copy of the app with a tiny RATE_LIMIT_MAX.
function loadAppWithRateLimit(max: number): Express {
  process.env.RATE_LIMIT_MAX = String(max);
  let app!: Express;
  jest.isolateModules(() => {
    ({ app } = require('../../app'));
  });
  delete process.env.RATE_LIMIT_MAX;
  return app;
}

describe('Rate limiting (RATE_LIMIT_MAX)', () => {
  it('answers 429 once the per-IP budget is spent', async () => {
    const api = request(loadAppWithRateLimit(2));

    await api.get('/product/9999').expect(404);
    await api.get('/product/9999').expect(404);
    const limited = await api.get('/product/9999').expect(429);

    expect(limited.body.message).toBe(
      'Too many requests, please try again later.'
    );
    expect(limited.headers['ratelimit-limit']).toBe('2');
  });

  it('never throttles /health or /metrics, even after the budget is spent', async () => {
    const api = request(loadAppWithRateLimit(1));

    await api.get('/product/9999').expect(404);
    await api.get('/product/9999').expect(429);

    for (let i = 0; i < 5; i++) {
      await api.get('/health').expect(200);
    }
    const metrics = await api.get('/metrics').expect(200);
    expect(metrics.text).toContain('rate_limit_rejections_total');
    expect(metrics.text).toMatch(/^reservations_active \d+$/m);
  });
});
