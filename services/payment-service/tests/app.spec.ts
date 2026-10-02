import request from 'supertest';
import { app, chaosMode } from '../src/app';

const validPayment = { orderId: 'order-1', amount: 10 };

describe('payment-service', () => {
  const originalMode = process.env.CHAOS_MODE;

  afterEach(() => {
    process.env.CHAOS_MODE = originalMode;
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  describe('chaosMode', () => {
    it.each(['fail', 'slow', 'flaky'])('returns %s when CHAOS_MODE=%s', (mode) => {
      process.env.CHAOS_MODE = mode;
      expect(chaosMode()).toBe(mode);
    });

    it.each([undefined, '', 'off', 'unknown'])('falls back to off for %p', (mode) => {
      if (mode === undefined) {
        delete process.env.CHAOS_MODE;
      } else {
        process.env.CHAOS_MODE = mode;
      }
      expect(chaosMode()).toBe('off');
    });
  });

  describe('GET /health', () => {
    it('reports OK with the active chaos mode', async () => {
      process.env.CHAOS_MODE = 'flaky';
      const res = await request(app).get('/health').expect(200);
      expect(res.body).toEqual({ status: 'OK', chaosMode: 'flaky' });
    });
  });

  describe('GET /metrics', () => {
    it('exposes Prometheus metrics including request duration', async () => {
      await request(app).post('/payments').send(validPayment);
      const res = await request(app).get('/metrics').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain(
        'http_request_duration_seconds_count{method="POST",route="/payments",status_code="201"}',
      );
    });
  });

  describe('POST /payments', () => {
    beforeEach(() => {
      process.env.CHAOS_MODE = 'off';
    });

    it('authorizes a valid payment', async () => {
      const res = await request(app).post('/payments').send(validPayment).expect(201);
      expect(res.body).toMatchObject({ ...validPayment, status: 'authorized' });
      expect(res.body.paymentId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it.each([
      ['missing body', undefined],
      ['non-string orderId', { orderId: 1, amount: 10 }],
      ['missing amount', { orderId: 'order-1' }],
      ['zero amount', { orderId: 'order-1', amount: 0 }],
      ['negative amount', { orderId: 'order-1', amount: -5 }],
    ])('rejects %s with 400', async (_case, body) => {
      const res = await request(app).post('/payments').send(body).expect(400);
      expect(res.body.message).toMatch(/orderId .* amount/);
    });

    it('returns 503 for every request when CHAOS_MODE=fail', async () => {
      process.env.CHAOS_MODE = 'fail';
      const res = await request(app).post('/payments').send(validPayment).expect(503);
      expect(res.body.message).toBe('Payment processor unavailable');
    });

    it('returns 503 when CHAOS_MODE=flaky and the dice roll fails', async () => {
      process.env.CHAOS_MODE = 'flaky';
      jest.spyOn(Math, 'random').mockReturnValue(0.1);
      await request(app).post('/payments').send(validPayment).expect(503);
    });

    it('authorizes when CHAOS_MODE=flaky and the dice roll succeeds', async () => {
      process.env.CHAOS_MODE = 'flaky';
      jest.spyOn(Math, 'random').mockReturnValue(0.9);
      await request(app).post('/payments').send(validPayment).expect(201);
    });

    it('delays the response by ~3s when CHAOS_MODE=slow', async () => {
      process.env.CHAOS_MODE = 'slow';
      const startedAt = Date.now();

      await request(app).post('/payments').send(validPayment).expect(201);

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2900);
    }, 10_000);

    it('uses CHAOS_SLOW_MS as the delay when CHAOS_MODE=slow', async () => {
      process.env.CHAOS_MODE = 'slow';
      process.env.CHAOS_SLOW_MS = '200';
      const startedAt = Date.now();

      try {
        await request(app).post('/payments').send(validPayment).expect(201);
      } finally {
        delete process.env.CHAOS_SLOW_MS;
      }

      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(190);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe('error handling', () => {
    it('rejects malformed JSON with 400', async () => {
      const res = await request(app)
        .post('/payments')
        .set('Content-Type', 'application/json')
        .send('{not json')
        .expect(400);
      expect(res.body).toEqual({ message: 'Malformed JSON body' });
    });
  });
});
