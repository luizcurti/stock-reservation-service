import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import client from 'prom-client';

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

app.get('/metrics', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const body = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(body);
  } catch (err) {
    next(err);
  }
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

// off = always authorize. fail = always 503 (hard outage — retries can't
// help, only the DestinationRule's outlierDetection ejecting this pod does).
// flaky = a real 503 on ~40% of requests, independently per request — this
// is what Istio's VirtualService retries (deploy/istio/virtualservice-payment.yaml)
// are actually able to mask, since it's a genuine upstream failure and not
// a mesh-injected fault (which Envoy applies before routing/retry logic and
// so is neither retried nor bounded by the route's timeout). slow = every
// response is delayed by CHAOS_SLOW_MS (default 3000) — a genuinely slow
// upstream, which the VirtualService's perTryTimeout/timeout DO cut off.
// Toggle live with:
//   kubectl set env deployment/payment-service CHAOS_MODE=flaky
type ChaosMode = 'off' | 'fail' | 'slow' | 'flaky';
export function chaosMode(): ChaosMode {
  const mode = process.env.CHAOS_MODE;
  return mode === 'fail' || mode === 'slow' || mode === 'flaky' ? mode : 'off';
}

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', chaosMode: chaosMode() });
});

app.post('/payments', async (req: Request, res: Response) => {
  const { orderId, amount } = req.body ?? {};

  if (typeof orderId !== 'string' || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ message: 'orderId (string) and amount (positive number) are required' });
    return;
  }

  const mode = chaosMode();
  console.log(`[payment-service] POST /payments orderId=${orderId} amount=${amount} chaosMode=${mode}`);

  if (mode === 'fail' || (mode === 'flaky' && Math.random() < 0.4)) {
    res.status(503).json({ message: 'Payment processor unavailable' });
    return;
  }

  if (mode === 'slow') {
    const delayMs = parseInt(process.env.CHAOS_SLOW_MS ?? '3000', 10);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  res.status(201).json({
    paymentId: randomUUID(),
    orderId,
    amount,
    status: 'authorized',
  });
});

app.use(function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ message: 'Malformed JSON body' });
    return;
  }
  console.error('[payment-service] Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});
