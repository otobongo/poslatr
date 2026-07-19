import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { connections } from './connections.js';
import { postTargetStatusEnum } from './enums.js';
import { posts } from './posts.js';
import { workspaces } from './workspaces.js';

// One row per (post, connected account). The target id doubles as the BullMQ
// jobId in ISS-007, which is what makes enqueue idempotent (SECURITY.md 2.22).
export const postTargets = pgTable(
  'psl_post_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    status: postTargetStatusEnum('status').notNull().default('draft'),
    bodyOverride: jsonb('body_override'),
    remotePostId: text('remote_post_id'),
    remoteUrl: text('remote_url'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    // User-safe error summary. Full provider detail stays server-side with a
    // correlation id (SECURITY.md 2.16); never a stack trace.
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('psl_post_targets_status_scheduled_at_idx').on(table.status, table.scheduledAt),
    index('psl_post_targets_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
    index('psl_post_targets_post_id_idx').on(table.postId),
  ],
);
