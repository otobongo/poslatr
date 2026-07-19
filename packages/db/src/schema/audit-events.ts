import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

// Append-only by policy (SECURITY.md 2.18). ISS-010 owns the writer API and
// the database-level grant/trigger that enforces append-only at the engine
// level; this table intentionally has no updatedAt column.
export const auditEvents = pgTable(
  'psl_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    outcome: text('outcome').notNull(),
    correlationId: text('correlation_id'),
    meta: jsonb('meta').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('psl_audit_events_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
    index('psl_audit_events_entity_type_entity_id_idx').on(table.entityType, table.entityId),
    index('psl_audit_events_correlation_id_idx').on(table.correlationId),
  ],
);
