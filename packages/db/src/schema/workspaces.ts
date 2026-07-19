import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Root tenant entity. v0.1 is single-workspace, but every domain table carries
// workspace_id from day one per PRD 3.1 and SECURITY.md 2.21.
export const workspaces = pgTable(
  'psl_workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('psl_workspaces_created_at_idx').on(table.createdAt)],
);
