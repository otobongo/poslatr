import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import {
  AuthExpiredError,
  RetryableProviderError,
  TerminalProviderError,
  type PreparedPost,
  type Provider,
} from '@poslatr/core';
import {
  claimPostTargetForPublishing,
  findConnectionById,
  recordPublishFailure,
  recordPublishSuccess,
  releasePublishingClaim,
  setConnectionHealth,
  withTransaction,
  writeAuditEvent,
  writeDeadLetter,
  type Database,
} from '@poslatr/db';
import { RETRY_MAX_ATTEMPTS, type PublishJobData } from './queues.js';

// Resolves the per-target work the processor needs. Injected so tests can
// supply a FakeProvider and canned credentials/media without a live vault or
// MinIO. Production wires this to the registry + vault + media module.
export interface PublishDeps {
  db: Database;
  getProvider(providerId: string): Provider;
  decryptCredentials(
    workspaceId: string,
    credentialsRef: string,
  ): Promise<Record<string, unknown>>;
  preparePost(
    workspaceId: string,
    postTargetId: string,
    correlationId: string,
  ): Promise<PreparedPost>;
  leaseMs?: number;
}

/**
 * The publish consumer, exactly per PRD 3.3.
 *
 * 1. Claim the target (scheduled -> publishing) BEFORE any network call. Zero
 *    rows means another worker won the race, or it was cancelled: exit cleanly.
 * 2. Resolve provider, credentials, media; call provider.publish().
 * 3. Success -> recordPublishSuccess, audit event.
 * 4. RetryableProviderError -> re-throw so BullMQ retries with backoff, until
 *    attempts are exhausted, then terminal-fail.
 * 5. AuthExpiredError -> mark the connection broken, terminal-fail with a
 *    distinct message, no retry.
 * 6. TerminalProviderError / anything else -> terminal-fail, no retry.
 *
 * Terminal failure writes the DLQ row, a user-safe lastError, a notification
 * (audit) event, and stops BullMQ retrying via UnrecoverableError.
 */
export async function processPublishJob(
  job: Job<PublishJobData>,
  deps: PublishDeps,
): Promise<{ outcome: 'published' | 'skipped'; remotePostId?: string }> {
  const { workspaceId, postTargetId, providerId, connectionId } = job.data;
  const correlationId = randomUUID();

  // (1) Claim before any side effect. Race-safe and lease-backed (ISS-003).
  const claimed = await claimPostTargetForPublishing(
    deps.db,
    workspaceId,
    postTargetId,
    deps.leaseMs,
  );
  if (claimed === 0) {
    // Lost the race or cancelled between enqueue and now: nothing to do.
    return { outcome: 'skipped' };
  }

  // How many attempts remain governs whether a retryable error terminal-fails.
  const attemptsRemaining = RETRY_MAX_ATTEMPTS - job.attemptsMade;

  try {
    const connection = await findConnectionById(deps.db, workspaceId, connectionId);
    if (!connection || connection.credentialsRef === null) {
      throw new TerminalProviderError(providerId, 'connection or credentials missing');
    }

    const provider = deps.getProvider(providerId);
    const credentials = await deps.decryptCredentials(workspaceId, connection.credentialsRef);
    const prepared = await deps.preparePost(workspaceId, postTargetId, correlationId);

    const result = await provider.publish(prepared, credentials);

    await withTransaction(deps.db, async (tx) => {
      await recordPublishSuccess(tx, workspaceId, postTargetId, {
        remotePostId: result.remotePostId,
        remoteUrl: result.remoteUrl,
      });
      await writeAuditEvent(tx, workspaceId, {
        actor: 'worker',
        action: 'publish',
        entityType: 'post_target',
        entityId: postTargetId,
        outcome: 'success',
        correlationId,
        meta: { providerId, remotePostId: result.remotePostId },
      });
    });

    return { outcome: 'published', remotePostId: result.remotePostId };
  } catch (err) {
    await handlePublishError(deps, {
      err,
      workspaceId,
      postTargetId,
      providerId,
      connectionId,
      correlationId,
      attemptsMade: job.attemptsMade,
      attemptsRemaining,
    });
    // Unreachable: handlePublishError always throws.
    throw err;
  }
}

interface ErrorContext {
  err: unknown;
  workspaceId: string;
  postTargetId: string;
  providerId: string;
  connectionId: string;
  correlationId: string;
  attemptsMade: number;
  attemptsRemaining: number;
}

async function handlePublishError(deps: PublishDeps, ctx: ErrorContext): Promise<never> {
  const { err, workspaceId, postTargetId, providerId, connectionId, correlationId } = ctx;

  // Retryable with attempts left: release the claim back to `scheduled` so the
  // BullMQ retry can re-claim it, then re-throw for backoff. Without this the
  // target stays `publishing` and the retry's claim (which requires
  // `scheduled`) would find zero rows and skip, silently dropping the retry.
  if (err instanceof RetryableProviderError && ctx.attemptsRemaining > 1) {
    await releaseClaimForRetry(deps, workspaceId, postTargetId);
    throw err;
  }

  // From here down every path is terminal.
  const authExpired = err instanceof AuthExpiredError;
  const userMessage = terminalUserMessage(err, authExpired);

  await withTransaction(deps.db, async (tx) => {
    if (authExpired) {
      // Connection state, not credential material: prompt a reconnect.
      await setConnectionHealth(tx, workspaceId, connectionId, 'broken');
    }
    await recordPublishFailure(tx, workspaceId, postTargetId, userMessage);
    await writeDeadLetter(tx, workspaceId, {
      postTargetId,
      providerId,
      errorClass: errorClassName(err),
      errorDetail: { message: redactedDetail(err) },
      attemptCount: ctx.attemptsMade + 1,
      correlationId,
    });
    await writeAuditEvent(tx, workspaceId, {
      actor: 'worker',
      action: 'publish',
      entityType: 'post_target',
      entityId: postTargetId,
      outcome: 'failed',
      correlationId,
      meta: { providerId, errorClass: errorClassName(err), authExpired },
    });
  });

  // Stop BullMQ retrying: this is terminal.
  throw new UnrecoverableError(userMessage);
}

async function releaseClaimForRetry(
  deps: PublishDeps,
  workspaceId: string,
  postTargetId: string,
): Promise<void> {
  await releasePublishingClaim(deps.db, workspaceId, postTargetId);
}

function errorClassName(err: unknown): string {
  if (err instanceof Error) return err.name;
  return 'UnknownError';
}

// Client-safe message: no stack, no provider response body (SECURITY.md 2.16).
function terminalUserMessage(err: unknown, authExpired: boolean): string {
  if (authExpired) {
    return 'Your connection needs to be re-authorized. Reconnect the account and try again.';
  }
  if (err instanceof TerminalProviderError) {
    return 'The platform rejected this post. Check the content against the platform limits.';
  }
  if (err instanceof RetryableProviderError) {
    return 'The platform was unavailable after several retries. Try again later.';
  }
  return 'Publishing failed due to an unexpected error.';
}

// Server-side detail is kept, but only the message string, never a full error
// object that could carry a provider response body or token.
function redactedDetail(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000);
}
