import * as dotenv from 'dotenv';
dotenv.config();
import cluster from 'cluster';
import express, { NextFunction, Request, Response } from 'express';
import { RegisterRoutes } from './build/routes';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ClusterMemoryStoreWorker } from '@express-rate-limit/cluster-memory-store';
import { ValidateError } from '@tsoa/runtime';
import { customError } from './src/customErrors/customErrors';
import {
  registry,
  httpRequestDuration,
  rateLimitRejections,
} from './src/config/metrics';
import { requestClusterMetrics } from './src/config/clusterMetrics';

export const app = express();

// Identifies which deployed version answered — used by the Istio canary demo
// to prove the 90/10 traffic split (deploy/istio/virtualservice-stock.yaml).
const SERVICE_VERSION = process.env.SERVICE_VERSION || 'v1';
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Version', SERVICE_VERSION);
  next();
});

app.use(
  cors({
    origin:
      process.env.ALLOWED_ORIGINS?.split(',') ??
      (process.env.NODE_ENV !== 'production' ? '*' : []),
  })
);

// Registered before the rate limiter: kubelet/Istio readiness and liveness
// probes hit this on every pod on a short interval and must never be
// throttled — a rate-limited health check looks identical to a dead pod to
// an orchestrator, which then kills a perfectly healthy instance.
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Also unthrottled and registered early, for the same reason as /health —
// and so a scrape is never counted in its own histogram.
app.get(
  '/metrics',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // In a cluster worker this process only holds its own share of the
      // counters — the primary aggregates every process's registry.
      const body = cluster.isWorker
        ? await requestClusterMetrics()
        : await registry.metrics();
      res.set('Content-Type', registry.contentType);
      res.end(body);
    } catch (error) {
      next(error);
    }
  }
);

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health' || req.path === '/metrics') {
    next();
    return;
  }
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({
      method: req.method,
      route: req.route?.path ?? req.path,
      status_code: res.statusCode,
    });
  });
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10),
  // Under the cluster (src/config/local.ts) each worker would otherwise
  // count hits in its own memory, multiplying the effective limit by
  // WEB_CONCURRENCY. The cluster store keeps one count in the primary.
  store: cluster.isWorker
    ? new ClusterMemoryStoreWorker({ prefix: 'stock-service' })
    : undefined,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    rateLimitRejections.inc();
    res
      .status(429)
      .json({ message: 'Too many requests, please try again later.' });
  },
});
app.use(limiter);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Swagger documentation - only load if available
try {
  const swaggerUI = require('swagger-ui-express');
  const swaggerDoc = require('./swagger.json');
  app.use('/docs', swaggerUI.serve);
  app.get('/docs', swaggerUI.setup(swaggerDoc));
} catch (error) {
  console.warn('Swagger documentation not available. Run build first.');
  app.get('/docs', (_req: Request, res: Response) => {
    res.status(503).json({
      message: 'API documentation not available. Please run build first.',
    });
  });
}

RegisterRoutes(app);

// Global error handler — must be 4-parameter for Express to treat it as error middleware
app.use(function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  // express.json() parse failure — a client error, not a server fault.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ message: 'Malformed JSON body' });
    return;
  }

  if (err instanceof ValidateError) {
    res.status(422).json({
      message: 'Validation failed',
      details: err.fields,
    });
    return;
  }

  if (err instanceof customError) {
    res.status(err.status).json({ message: err.message });
    return;
  }

  if (err instanceof Error) {
    res.status(500).json({ message: 'Internal server error' });
    return;
  }

  next();
});

// 404 Not Found Handler
app.use(function notFoundHandler(_req: Request, res: Response) {
  res.status(404).send({
    message: 'Not Found',
  });
});
