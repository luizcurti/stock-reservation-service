import cluster, { Worker } from 'cluster';
import { randomUUID } from 'crypto';
import { AggregatorRegistry } from 'prom-client';
import { registry } from './metrics';

// With WEB_CONCURRENCY > 1 every process (the primary plus each worker) has
// its own in-memory registry, and a scrape only reaches whichever worker
// the OS hands the connection to — so without aggregation each scrape shows
// a random quarter of the traffic, and reservations_released_total (only
// ever incremented in the primary, where the expiry scheduler runs) is
// never visible at all. The worker serving /metrics asks the primary, which
// collects every process's registry over IPC and merges them with
// AggregatorRegistry (counters/histograms summed, per-metric `aggregator`
// overrides respected — e.g. reservations_active, which is read from the DB
// and identical in every process).

type MetricsJson = Awaited<ReturnType<typeof registry.getMetricsAsJSON>>;

const COLLECT_REQ = 'stock-service:metrics:collect-req';
const COLLECT_RES = 'stock-service:metrics:collect-res';
const SCRAPE_REQ = 'stock-service:metrics:scrape-req';
const SCRAPE_RES = 'stock-service:metrics:scrape-res';
const IPC_TIMEOUT_MS = 5000;

interface IpcMessage {
  type: string;
  id: string;
  metrics?: MetricsJson;
  body?: string;
  error?: string;
}

function isIpcMessage(message: unknown): message is IpcMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as IpcMessage).type === 'string' &&
    typeof (message as IpcMessage).id === 'string'
  );
}

// Pending requests in this process, keyed by request id.
const pending = new Map<
  string,
  { resolve: (msg: IpcMessage) => void; reject: (err: Error) => void }
>();

function awaitReply(id: string, send: () => void): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Timed out waiting for cluster metrics.'));
    }, IPC_TIMEOUT_MS);
    pending.set(id, {
      resolve: msg => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(msg);
      },
      reject: err => {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      },
    });
    send();
  });
}

function settle(message: IpcMessage): void {
  const request = pending.get(message.id);
  if (!request) {
    return;
  }
  if (message.error) {
    request.reject(new Error(message.error));
  } else {
    request.resolve(message);
  }
}

async function collectFromWorker(worker: Worker): Promise<MetricsJson> {
  const id = randomUUID();
  const reply = await awaitReply(id, () =>
    worker.send({ type: COLLECT_REQ, id })
  );
  return reply.metrics ?? [];
}

async function aggregateClusterMetrics(): Promise<string> {
  const workers = Object.values(cluster.workers ?? {}).filter(
    (w): w is Worker => w !== undefined && w.isConnected()
  );
  const all = await Promise.all([
    registry.getMetricsAsJSON(),
    ...workers.map(collectFromWorker),
  ]);
  return AggregatorRegistry.aggregate(all).metrics();
}

/** Call once in the cluster primary, before forking workers. */
export function setupPrimaryMetricsAggregation(): void {
  cluster.on('message', (worker: Worker, message: unknown) => {
    if (!isIpcMessage(message)) {
      return;
    }
    if (message.type === COLLECT_RES) {
      settle(message);
    } else if (message.type === SCRAPE_REQ) {
      aggregateClusterMetrics()
        .then(body => worker.send({ type: SCRAPE_RES, id: message.id, body }))
        .catch((error: unknown) =>
          worker.send({
            type: SCRAPE_RES,
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          })
        );
    }
  });
}

/** Call once in each cluster worker. */
export function setupWorkerMetricsResponder(): void {
  process.on('message', (message: unknown) => {
    if (!isIpcMessage(message)) {
      return;
    }
    if (message.type === SCRAPE_RES) {
      settle(message);
    } else if (message.type === COLLECT_REQ) {
      registry
        .getMetricsAsJSON()
        .then(metrics =>
          process.send?.({ type: COLLECT_RES, id: message.id, metrics })
        )
        .catch((error: unknown) =>
          process.send?.({
            type: COLLECT_RES,
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
          })
        );
    }
  });
}

/** From a worker: ask the primary for the whole cluster's metrics. */
export async function requestClusterMetrics(): Promise<string> {
  const id = randomUUID();
  const reply = await awaitReply(id, () =>
    process.send?.({ type: SCRAPE_REQ, id })
  );
  return reply.body ?? '';
}
