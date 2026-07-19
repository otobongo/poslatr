import { pgEnum } from 'drizzle-orm/pg-core';

// Post lifecycle per PRD 3.1. Transitions are enforced in the repository layer
// (see repositories/transitions.ts), never by the enum alone.
export const postStatusEnum = pgEnum('psl_post_status', [
  'draft',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled',
]);

// Per-target status mirrors the post lifecycle: one post can succeed on one
// platform and fail on another, so targets carry their own independent status.
export const postTargetStatusEnum = pgEnum('psl_post_target_status', [
  'draft',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled',
]);

// Connection health per PRD 3.1.
export const connectionHealthEnum = pgEnum('psl_connection_health', [
  'ok',
  'expiring',
  'broken',
]);
