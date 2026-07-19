import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

// Per-provider queues (PRD 3.3 item 6): a broken provider only poisons its own
// queue. The BullMQ jobId is the post-target id, which is what makes enqueue
// idempotent (SECURITY.md 2.22) and lets cancel/reschedule address a job
// without tracking a separate handle.

export interface PublishJobData {
  workspaceId: string;
  postTargetId: string;
  providerId: string;
  connectionId: string;
}

export const RETRY_MAX_ATTEMPTS = 5;

// BullMQ 5 forbids ':' in queue names (it namespaces Redis keys with ':'
// internally). PRD 3.3's "publish:mastodon" is illustrative; the real queue
// name uses a hyphen.
export function queueNameFor(providerId: string): string {
  return `publish-${providerId}`;
}

export class PublishQueues {
  readonly #connection: Redis;
  readonly #queues = new Map<string, Queue<PublishJobData>>();

  constructor(connection: Redis) {
    this.#connection = connection;
  }

  #queue(providerId: string): Queue<PublishJobData> {
    let queue = this.#queues.get(providerId);
    if (!queue) {
      queue = new Queue<PublishJobData>(queueNameFor(providerId), {
        connection: this.#connection,
        defaultJobOptions: {
          attempts: RETRY_MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: 1000 },
          // Keep terminal jobs briefly for inspection, then let them go.
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86400 },
        },
      });
      this.#queues.set(providerId, queue);
    }
    return queue;
  }

  /**
   * Enqueues (or re-enqueues) a delayed publish job. jobId = postTargetId makes
   * this idempotent: enqueuing the same target twice does not create a second
   * job. Reschedule is remove-then-add so the delay is recomputed atomically
   * from the caller's perspective (PRD 3.3 item 1).
   */
  async schedule(data: PublishJobData, fireAt: Date, now: Date = new Date()): Promise<void> {
    const delay = Math.max(0, fireAt.getTime() - now.getTime());
    const queue = this.#queue(data.providerId);
    // Remove any existing job for this target first so a reschedule takes the
    // new delay rather than being ignored as a duplicate jobId.
    await queue.remove(data.postTargetId);
    await queue.add('publish', data, { jobId: data.postTargetId, delay });
  }

  /**
   * Cancels a scheduled job. Returns 'removed' if a pending job was cancelled,
   * 'absent' if nothing was queued, or 'active' if the job is currently running
   * (which the caller must NOT treat as cancelled: a mid-publishing target is
   * rejected at the status layer).
   *
   * BullMQ's remove() returns 1 even for a non-existent job, so existence and
   * state are determined via getJob() + getState(), not the remove result.
   */
  async cancel(providerId: string, postTargetId: string): Promise<'removed' | 'absent' | 'active'> {
    const queue = this.#queue(providerId);
    const job = await queue.getJob(postTargetId);
    if (!job) return 'absent';

    const state = await job.getState();
    if (state === 'active') return 'active';

    await queue.remove(postTargetId);
    return 'removed';
  }

  async close(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((q) => q.close()));
  }
}
