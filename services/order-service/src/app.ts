import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { Agent, setGlobalDispatcher } from 'undici';
import client from 'prom-client';

// fetch()'s default dispatcher doesn't bound how many sockets it opens per
// origin. Under real concurrent load that's not just slow — it's a hard
// failure mode: with WEB_CONCURRENCY forking multiple workers that all
// share this container's one network namespace (and so its one ephemeral
// port range), an unbounded fan-out of outbound connections to
// stock-service/payment-service exhausted local ports outright
// (ECONNREFUSED-adjacent "connect EADDRNOTAVAIL", observed under a
// 5000-concurrent-checkout test). Capping concurrent connections per origin
// and reusing them via keep-alive keeps that fan-out bounded regardless of
// how many workers or how much traffic there is.
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    connections: 256,
  })
);

export const app = express();
app.use(express.json());

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10, 15],
  registers: [registry],
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health' || req.path === '/metrics') {
    next();
    return;
  }
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.path, status_code: res.statusCode });
  });
  next();
});

const STOCK_SERVICE_URL = process.env.STOCK_SERVICE_URL || 'http://localhost:3000';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3002';
// Always v1 — order-service isn't part of the canary demo, only stock-service is.
// Kept as a response header so every hop in the mesh is identifiable the same way.
const SERVICE_VERSION = 'v1';

const CALL_TIMEOUT_MS = 5000;

async function callJson<T>(url: string, init: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Version', SERVICE_VERSION);
  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', version: SERVICE_VERSION });
});

interface ReserveResponse {
  id: number;
  product: string;
  reservationToken: string;
}

interface PaymentResponse {
  paymentId: string;
  status: string;
  message?: string;
}

app.post('/orders', async (req: Request, res: Response) => {
  const { productId, amount } = req.body ?? {};

  if (typeof productId !== 'number') {
    res.status(400).json({ message: 'productId (number) is required' });
    return;
  }
  const chargeAmount = typeof amount === 'number' && amount > 0 ? amount : 10;
  const orderId = randomUUID();

  console.log(`[order-service] order ${orderId}: reserving productId=${productId}`);
  let reservation: ReserveResponse;
  try {
    const reserveRes = await callJson<ReserveResponse>(`${STOCK_SERVICE_URL}/product/${productId}/reserve`, {
      method: 'POST',
    });
    if (reserveRes.status !== 201) {
      res.status(reserveRes.status).json({ message: 'Could not reserve stock', details: reserveRes.body });
      return;
    }
    reservation = reserveRes.body;
  } catch (err) {
    console.error(`[order-service] order ${orderId}: stock-service call failed`, err);
    res.status(502).json({ message: 'stock-service unavailable' });
    return;
  }

  console.log(`[order-service] order ${orderId}: charging payment, token=${reservation.reservationToken}`);
  let payment: PaymentResponse;
  try {
    const paymentRes = await callJson<PaymentResponse>(`${PAYMENT_SERVICE_URL}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, amount: chargeAmount }),
    });
    payment = paymentRes.body;

    if (paymentRes.status !== 201) {
      console.log(`[order-service] order ${orderId}: payment declined, releasing reservation`);
      await callJson(`${STOCK_SERVICE_URL}/product/${productId}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationToken: reservation.reservationToken }),
      }).catch((err) => console.error(`[order-service] order ${orderId}: failed to release reservation`, err));

      res.status(402).json({ message: 'Payment declined', details: payment });
      return;
    }
  } catch (err) {
    console.error(`[order-service] order ${orderId}: payment-service call failed, releasing reservation`, err);
    await callJson(`${STOCK_SERVICE_URL}/product/${productId}/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationToken: reservation.reservationToken }),
    }).catch((releaseErr) => console.error(`[order-service] order ${orderId}: failed to release reservation`, releaseErr));

    res.status(502).json({ message: 'payment-service unavailable' });
    return;
  }

  console.log(`[order-service] order ${orderId}: confirming sale`);
  try {
    await callJson(`${STOCK_SERVICE_URL}/product/${productId}/sold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationToken: reservation.reservationToken }),
    });
  } catch (err) {
    console.error(`[order-service] order ${orderId}: failed to confirm sale after payment`, err);
    res.status(502).json({ message: 'Payment captured but stock confirmation failed', orderId });
    return;
  }

  res.status(201).json({
    orderId,
    productId,
    reservationToken: reservation.reservationToken,
    paymentId: payment.paymentId,
    status: 'confirmed',
  });
});

app.use(function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[order-service] Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});
