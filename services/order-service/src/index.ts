import cluster from 'cluster';
import os from 'os';
import { app } from './app';

const PORT = process.env.PORT || 3001;

// A single Node process is single-threaded for JS execution, so it becomes
// the throughput ceiling under real concurrent load — measured under a
// 5000-concurrent-checkout test, this process alone pegged 100-138% CPU and
// drove most of the request failures. Forking one worker per core (capped
// at 4 by default) uses the whole container. Set WEB_CONCURRENCY=1 where
// horizontal scaling already happens some other way (multiple k8s replicas)
// so pods don't fork workers that just fight each other for the same
// per-pod CPU limit.
const numWorkers = parseInt(
  process.env.WEB_CONCURRENCY ?? String(Math.min(os.cpus().length, 4)),
  10
);

if (numWorkers > 1 && cluster.isPrimary) {
  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code, signal) => {
    console.error(
      `[cluster] worker ${worker.process.pid} exited (code=${code} signal=${signal}), restarting`
    );
    cluster.fork();
  });
} else {
  app.listen(PORT, () => {
    console.log(`[order-service] listening on port ${PORT}`);
  });
}
