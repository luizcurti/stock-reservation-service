import * as dotenv from 'dotenv';
dotenv.config();
import express, { NextFunction, Request, Response } from 'express';
import bodyParser from 'body-parser';
import { RegisterRoutes } from './build/routes';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ValidateError } from '@tsoa/runtime';
import { customError } from './src/customErrors/customErrors';
import {
  registry,
  httpRequestDuration,
  rateLimitRejections,
} from './src/config/metrics';

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

app.use(
  bodyParser.urlencoded({
    extended: true,
  })
);
app.use(bodyParser.json());

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
