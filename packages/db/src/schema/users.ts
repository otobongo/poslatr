import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

// passwordHash is nullable in ISS-003: the seed creates a user row without
// credentials. Argon2id hashing and the login flow land in ISS-009, which owns
// all credential handling (stop condition per PRD 4.3).
export const users = pgTable(
  'psl_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('psl_users_email_key').on(table.email),
    index('psl_users_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
  ],
);
