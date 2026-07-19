import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
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
    // No single-column .references() here: both parents are reached through the
    // composite foreign keys below, which pin workspace_id as part of the key.
    postId: uuid('post_id').notNull(),
    connectionId: uuid('connection_id').notNull(),
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
    // Claim lease (ISS-003-F3). Set when a worker moves the target into
    // `publishing`; a sweeper reclaims targets whose lease expired, so a worker
    // killed mid-publish cannot strand the row forever.
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('psl_post_targets_status_scheduled_at_idx').on(table.status, table.scheduledAt),
    index('psl_post_targets_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
    index('psl_post_targets_post_id_idx').on(table.postId),
    // Lets the stale-claim sweeper find expired leases without a full scan.
    index('psl_post_targets_status_claim_expires_at_idx').on(table.status, table.claimExpiresAt),
    // Target of the composite FK on psl_dead_letters.
    uniqueIndex('psl_post_targets_id_workspace_id_key').on(table.id, table.workspaceId),
    // ISS-003-F1: composite FKs make a cross-workspace target structurally
    // impossible. A row whose post_id belongs to another workspace has no
    // matching (id, workspace_id) pair in the parent and is rejected by
    // Postgres, regardless of what the repository layer does.
    foreignKey({
      name: 'psl_post_targets_post_workspace_fk',
      columns: [table.postId, table.workspaceId],
      foreignColumns: [posts.id, posts.workspaceId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'psl_post_targets_connection_workspace_fk',
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }).onDelete('restrict'),
  ],
);
