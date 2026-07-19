import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { postTargets } from './post-targets.js';
import { workspaces } from './workspaces.js';

// Written by ISS-007 on terminal publish failure (PRD 3.3 item 5). errorDetail
// holds server-side diagnostic context; the user-facing message lives on the
// post target's lastError (SECURITY.md 2.16).
export const deadLetters = pgTable(
  'psl_dead_letters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    // Reached via the composite FK below so a dead letter cannot reference a
    // post target from another workspace (ISS-003-F1).
    postTargetId: uuid('post_target_id').notNull(),
    providerId: text('provider_id').notNull(),
    errorClass: text('error_class').notNull(),
    errorDetail: jsonb('error_detail').notNull().default({}),
    attemptCount: integer('attempt_count').notNull(),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('psl_dead_letters_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
    index('psl_dead_letters_post_target_id_idx').on(table.postTargetId),
    foreignKey({
      name: 'psl_dead_letters_post_target_workspace_fk',
      columns: [table.postTargetId, table.workspaceId],
      foreignColumns: [postTargets.id, postTargets.workspaceId],
    }).onDelete('cascade'),
  ],
);
