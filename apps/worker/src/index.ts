import { loadEnv } from '@poslatr/core';
import { Redis } from 'ioredis';
import type { Worker } from 'bullmq';
import type { PublishJobData } from './queues.js';
import { stopPublishWorkers } from './publish-worker.js';

// The worker process. ISS-007 provides the scheduler machinery (queues,
// processor, per-provider workers). Wiring concrete providers, the vault, and
// the media module into PublishDeps and starting a worker per enabled provider
// is the job of the composition step that lands with the first concrete
// provider (ISS-008) and the app boot; here we establish the process lifecycle
// and a clean SIGTERM drain so that composition has a stable host.

const env = loadEnv();
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const workers: Worker<PublishJobData>[] = [];
let shuttingDown = false;

async function main(): Promise<void> {
  await connection.connect().catch(() => undefined);
  console.log(`[worker] up, NODE_ENV=${env.NODE_ENV}, providers=${env.ENABLED_PROVIDERS.join(',') || '(none)'}`);
  // Providers are wired in the ISS-008 composition step; until then the process
  // stays alive and idle, ready to drain on SIGTERM.
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal}: draining ${workers.length} worker(s)`);
  // worker.close() stops accepting new jobs and waits for in-flight ones.
  await stopPublishWorkers(workers);
  connection.disconnect();
  console.log('[worker] drained, exiting');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err: unknown) => {
  console.error('[worker] fatal startup error', err);
  process.exit(1);
});
