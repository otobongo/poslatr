import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { postStatusEnum } from './enums.js';
import { workspaces } from './workspaces.js';

// scheduledAt is always stored UTC; the author's original IANA timezone is kept
// alongside it so ISS-007 can fire at the correct wall-clock time across DST
// shifts (PRD 3.3 item 7, SECURITY.md 2.3).
export const posts = pgTable(
  'psl_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    status: postStatusEnum('status').notNull().default('draft'),
    body: jsonb('body').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    timezone: text('timezone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('psl_posts_status_scheduled_at_idx').on(table.status, table.scheduledAt),
    index('psl_posts_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
    // Redundant given the primary key, but required as the target of the
    // composite FK on psl_post_targets that pins (post_id, workspace_id)
    // together, making cross-workspace targets unrepresentable (ISS-003-F1).
    uniqueIndex('psl_posts_id_workspace_id_key').on(table.id, table.workspaceId),
  ],
);
