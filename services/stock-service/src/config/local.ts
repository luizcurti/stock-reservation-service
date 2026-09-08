import cluster from 'cluster';
import os from 'os';
import { app } from '../../app';
import { startReservationExpiryScheduler } from './reservationExpiryScheduler';

const port = process.env.PORT || 3000;

// A single Node process is single-threaded for JS execution, so it becomes
// the bottleneck under real concurrent load well before the MySQL pool does
// (measured: a single instance pegged 100-138% CPU at 5000 concurrent
// checkouts, driving ~32% request failures). Forking one worker per core
// (capped at 4 by default so `docker compose up` doesn't spawn dozens of
// processes on a big dev machine) uses the whole container. Set
// WEB_CONCURRENCY=1 where horizontal scaling already happens some other way
// (e.g. multiple k8s replicas) so pods don't fork workers that only end up
// fighting each other for the same per-pod CPU limit.
const numWorkers = parseInt(
  process.env.WEB_CONCURRENCY ?? String(Math.min(os.cpus().length, 4)),
  10
);

if (numWorkers > 1 && cluster.isPrimary) {
  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }
  // Only the primary polls for expired reservations — every worker doing it
  // independently would just multiply DB load for no benefit, since
  // returnStock's FOR UPDATE lock already makes a release idempotent.
  startReservationExpiryScheduler();

  cluster.on('exit', (worker, code, signal) => {
    console.error(
      `[cluster] worker ${worker.process.pid} exited (code=${code} signal=${signal}), restarting`
    );
    cluster.fork();
  });
} else {
  app.listen(port, () => {
    // Server started successfully
  });
  if (numWorkers <= 1) {
    startReservationExpiryScheduler();
  }
}
