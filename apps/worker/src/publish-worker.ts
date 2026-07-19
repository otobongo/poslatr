import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { queueNameFor, type PublishJobData } from './queues.js';
import { processPublishJob, type PublishDeps } from './publish-processor.js';

// One BullMQ Worker per enabled provider, consuming that provider's queue so a
// broken provider only poisons its own (PRD 3.3 item 6).

export function startPublishWorker(
  providerId: string,
  connection: Redis,
  deps: PublishDeps,
  options: { concurrency?: number } = {},
): Worker<PublishJobData> {
  return new Worker<PublishJobData>(
    queueNameFor(providerId),
    async (job) => processPublishJob(job, deps),
    {
      connection,
      concurrency: options.concurrency ?? 4,
    },
  );
}

/**
 * Graceful shutdown (PRD 3.3, ISS-007): worker.close() stops taking new jobs and
 * waits for in-flight ones to finish before resolving.
 */
export async function stopPublishWorkers(workers: Worker<PublishJobData>[]): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
}
