import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { credentials } from './credentials.js';
import { connectionHealthEnum } from './enums.js';
import { workspaces } from './workspaces.js';

// credentialsRef points at vault-encrypted material in psl_credentials
// (ISS-004). No plaintext credential ever lands in this table; SECURITY.md 2.1
// and 2.19.
export const connections = pgTable(
  'psl_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    providerId: text('provider_id').notNull(),
    displayName: text('display_name').notNull(),
    credentialsRef: uuid('credentials_ref'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    health: connectionHealthEnum('health').notNull().default('ok'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('psl_connections_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
    index('psl_connections_health_idx').on(table.health),
    // Target of the composite FK on psl_post_targets, so a target can never
    // reference a connection from another workspace (ISS-003-F1).
    uniqueIndex('psl_connections_id_workspace_id_key').on(table.id, table.workspaceId),
    // Same F1 pattern inbound: a connection can only reference a credential in
    // its own workspace. RESTRICT so a credential cannot vanish from under a
    // live connection.
    foreignKey({
      name: 'psl_connections_credentials_workspace_fk',
      columns: [table.credentialsRef, table.workspaceId],
      foreignColumns: [credentials.id, credentials.workspaceId],
    }).onDelete('restrict'),
  ],
);
