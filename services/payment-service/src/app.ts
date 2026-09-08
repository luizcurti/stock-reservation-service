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

// off = always authorize. fail = always 503 (hard outage — retries can't
// help, only the DestinationRule's outlierDetection ejecting this pod does).
// flaky = a real 503 on ~40% of requests, independently per request — this
// is what Istio's VirtualService retries (deploy/istio/virtualservice-payment.yaml)
// are actually able to mask, since it's a genuine upstream failure and not
// a mesh-injected fault (which Envoy applies before routing/retry logic and
// so is intentionally NOT retried — see deploy/istio/demo/fault-injection-payment.yaml).
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
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  res.status(201).json({
    paymentId: randomUUID(),
    orderId,
    amount,
    status: 'authorized',
  });
});

app.use(function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[payment-service] Unhandled error:', err);
  res.status(500).json({ message: 'Internal server error' });
});
