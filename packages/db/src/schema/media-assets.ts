import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

// storageKey is always server-generated (UUID-based), never derived from a
// user-supplied filename; SECURITY.md 2.11.
export const mediaAssets = pgTable(
  'psl_media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    checksum: text('checksum').notNull(),
    originalFilename: text('original_filename'),
    renditions: jsonb('renditions').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Checksum dedupe is per-workspace: ISS-006 returns the existing record on
    // re-upload rather than creating a second object.
    uniqueIndex('psl_media_assets_workspace_id_checksum_key').on(table.workspaceId, table.checksum),
    uniqueIndex('psl_media_assets_storage_key_key').on(table.storageKey),
    index('psl_media_assets_workspace_id_created_at_idx').on(table.workspaceId, table.createdAt),
  ],
);
