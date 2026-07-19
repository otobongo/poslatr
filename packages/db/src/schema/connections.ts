import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { connectionHealthEnum } from './enums.js';
import { workspaces } from './workspaces.js';

// credentialsRef points at vault-encrypted material (ISS-004). No plaintext
// credential ever lands in this table; SECURITY.md 2.1 and 2.19.
export const connections = pgTable(
  'psl_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    providerId: text('provider_id').notNull(),
    displayName: text('display_name').notNull(),
    credentialsRef: text('credentials_ref'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    health: connectionHealthEnum('health').notNull().default('ok'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('psl_connections_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
    index('psl_connections_health_idx').on(table.health),
  ],
);
