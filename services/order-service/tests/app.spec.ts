import express, { Request, Response } from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import request from 'supertest';
import type { Express } from 'express';

// Real HTTP fakes for stock-service and payment-service, so the orchestration
// is exercised over actual sockets (timeouts, status codes, JSON parsing)
// rather than through a mocked fetch.
type Handler = (req: Request, res: Response) => void;

interface FakeDownstream {
  server: Server;
  url: string;
  calls: { path: string; body: unknown }[];
  handlers: Record<string, Handler>;
}

async function startFake(): Promise<FakeDownstream> {
  const fake = express();
  fake.use(express.json());
  const calls: FakeDownstream['calls'] = [];
  const handlers: Record<string, Handler> = {};
  fake.use((req, res) => {
    calls.push({ path: req.path, body: req.body });
    const handler = handlers[`${req.method} ${req.path}`];
    if (handler) {
      handler(req, res);
    } else {
      res.status(404).json({ message: 'fake: no handler' });
    }
  });
  const server = await new Promise<Server>((resolve) => {
    const s = fake.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, calls, handlers };
}

async function stopFake(fake: FakeDownstream): Promise<void> {
  fake.server.closeAllConnections();
  await new Promise((resolve) => fake.server.close(resolve));
}

const TOKEN = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('order-service', () => {
  let stock: FakeDownstream;
  let payment: FakeDownstream;
  let app: Express;

  beforeAll(async () => {
    stock = await startFake();
    payment = await startFake();
    process.env.STOCK_SERVICE_URL = stock.url;
    process.env.PAYMENT_SERVICE_URL = payment.url;
    // Imported after the env is set: the downstream URLs are read at module load.
    ({ app } = await import('../src/app'));
  });

  afterAll(async () => {
    await Promise.all([stopFake(stock), stopFake(payment)]);
  });

  beforeEach(() => {
    for (const fake of [stock, payment]) {
      fake.calls.length = 0;
      for (const key of Object.keys(fake.handlers)) {
        delete fake.handlers[key];
      }
    }
    stock.handlers['POST /product/1/reserve'] = (_req, res) => {
      res.status(201).json({ id: 1, product: 'Ball', reservationToken: TOKEN });
    };
    stock.handlers['POST /product/1/sold'] = (_req, res) => {
      res.status(204).end();
    };
    stock.handlers['POST /product/1/return'] = (_req, res) => {
      res.status(204).end();
    };
    payment.handlers['POST /payments'] = (req, res) => {
      res.status(201).json({ paymentId: 'pay-1', orderId: req.body.orderId, status: 'authorized' });
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const stockPaths = (): string[] => stock.calls.map((c) => c.path);

  describe('GET /health', () => {
    it('reports OK and the service version header', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.body).toEqual({ status: 'OK', version: 'v1' });
      expect(res.headers['x-version']).toBe('v1');
    });
  });

  describe('GET /metrics', () => {
    it('exposes request duration for /orders', async () => {
      await request(app).post('/orders').send({ productId: 1 });
      const res = await request(app).get('/metrics').expect(200);
      expect(res.text).toContain(
        'http_request_duration_seconds_count{method="POST",route="/orders",status_code="201"}',
      );
    });
  });

  describe('POST /orders', () => {
    it('reserves, charges and confirms the sale (happy path)', async () => {
      const res = await request(app).post('/orders').send({ productId: 1, amount: 25 }).expect(201);

      expect(res.body).toMatchObject({
        productId: 1,
        reservationToken: TOKEN,
        paymentId: 'pay-1',
        status: 'confirmed',
      });
      expect(stockPaths()).toEqual(['/product/1/reserve', '/product/1/sold']);
      expect(stock.calls[1].body).toEqual({ reservationToken: TOKEN });
      expect(payment.calls[0].body).toEqual({ orderId: res.body.orderId, amount: 25 });
    });

    it('charges the default amount when none (or an invalid one) is given', async () => {
      await request(app).post('/orders').send({ productId: 1, amount: -3 }).expect(201);
      expect(payment.calls[0].body).toMatchObject({ amount: 10 });
    });

    it.each([
      ['missing productId', {}],
      ['string productId', { productId: '1' }],
    ])('rejects %s with 400 without calling downstream', async (_case, body) => {
      const res = await request(app).post('/orders').send(body).expect(400);
      expect(res.body.message).toBe('productId (number) is required');
      expect(stock.calls).toHaveLength(0);
    });

    it('rejects malformed JSON with 400', async () => {
      await request(app).post('/orders').set('Content-Type', 'application/json').send('{oops').expect(400);
    });

    it('surfaces a stock-service rejection (e.g. insufficient stock) with its status', async () => {
      stock.handlers['POST /product/1/reserve'] = (_req, res) => {
        res.status(400).json({ message: 'Insufficient stock quantity.' });
      };

      const res = await request(app).post('/orders').send({ productId: 1 }).expect(400);

      expect(res.body).toEqual({
        message: 'Could not reserve stock',
        details: { message: 'Insufficient stock quantity.' },
      });
      expect(payment.calls).toHaveLength(0);
    });

    it('returns 502 when stock-service is unreachable', async () => {
      stock.handlers['POST /product/1/reserve'] = (req) => {
        req.socket.destroy();
      };

      const res = await request(app).post('/orders').send({ productId: 1 }).expect(502);

      expect(res.body.message).toBe('stock-service unavailable');
      expect(payment.calls).toHaveLength(0);
    });

    it('releases the reservation and returns 402 when payment is declined', async () => {
      payment.handlers['POST /payments'] = (_req, res) => {
        res.status(402).json({ message: 'Card declined' });
      };

      const res = await request(app).post('/orders').send({ productId: 1 }).expect(402);

      expect(res.body).toEqual({ message: 'Payment declined', details: { message: 'Card declined' } });
      expect(stockPaths()).toEqual(['/product/1/reserve', '/product/1/return']);
      expect(stock.calls[1].body).toEqual({ reservationToken: TOKEN });
    });

    it.each([500, 503, 504])(
      'releases the reservation and returns 502 (not a decline) when payment-service answers %i',
      async (status) => {
        payment.handlers['POST /payments'] = (_req, res) => {
          res.status(status).json({ message: 'Payment processor unavailable' });
        };

        const res = await request(app).post('/orders').send({ productId: 1 }).expect(502);

        expect(res.body).toEqual({
          message: 'payment-service unavailable',
          details: { message: 'Payment processor unavailable' },
        });
        expect(stockPaths()).toEqual(['/product/1/reserve', '/product/1/return']);
      },
    );

    it('releases the reservation and returns 502 when payment-service is unreachable', async () => {
      payment.handlers['POST /payments'] = (req) => {
        req.socket.destroy();
      };

      const res = await request(app).post('/orders').send({ productId: 1 }).expect(502);

      expect(res.body.message).toBe('payment-service unavailable');
      expect(stockPaths()).toEqual(['/product/1/reserve', '/product/1/return']);
    });

    it('still answers 402 when releasing the reservation itself fails', async () => {
      payment.handlers['POST /payments'] = (_req, res) => {
        res.status(402).json({});
      };
      stock.handlers['POST /product/1/return'] = (req) => {
        req.socket.destroy();
      };

      await request(app).post('/orders').send({ productId: 1 }).expect(402);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to release reservation'),
        expect.anything(),
      );
    });

    it('returns 502 (not "confirmed") when stock-service refuses to record the sale', async () => {
      stock.handlers['POST /product/1/sold'] = (_req, res) => {
        res.status(404).json({ message: 'Reservation not found.' });
      };

      const res = await request(app).post('/orders').send({ productId: 1 }).expect(502);

      expect(res.body).toEqual({
        message: 'Payment captured but stock confirmation failed',
        orderId: expect.any(String),
      });
    });

    it('returns 502 when stock-service is unreachable while confirming the sale', async () => {
      stock.handlers['POST /product/1/sold'] = (req) => {
        req.socket.destroy();
      };

      await request(app).post('/orders').send({ productId: 1 }).expect(502);
    });
  });
});
