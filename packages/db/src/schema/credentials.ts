import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

// Vault-encrypted provider credentials (ISS-004). Rows here are opaque to
// everything except packages/vault: ciphertext and nonce are base64 text, and
// plaintext never exists outside a vault call scope (SECURITY.md 2.1, 2.19).
// psl_connections.credentials_ref points at this table's id.
export const credentials = pgTable(
  'psl_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    ciphertext: text('ciphertext').notNull(),
    nonce: text('nonce').notNull(),
    // Which master key encrypted this row. rotateMasterKey re-encrypts rows
    // whose key_version is not current, which is what makes an interrupted
    // rotation resumable: finished rows already carry the new version.
    keyVersion: integer('key_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('psl_credentials_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
    // Rotation scans by key version; keep it cheap.
    index('psl_credentials_key_version_idx').on(table.keyVersion),
    // FK target pattern established in ISS-003-F1, ready for any future child.
    uniqueIndex('psl_credentials_id_workspace_id_key').on(table.id, table.workspaceId),
  ],
);
