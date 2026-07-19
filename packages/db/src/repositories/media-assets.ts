import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../client.js';
import { mediaAssets } from '../schema/media-assets.js';

// Media asset metadata. Objects live in MinIO; this table is the index.
// storage_key is server-generated (SECURITY.md 2.11), never a client filename.

export const createMediaAssetInput = z.object({
  storageKey: z.string().min(1).max(512),
  mime: z.string().min(1).max(255),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  durationMs: z.number().int().positive().nullable().optional(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase hex SHA-256'),
  originalFilename: z.string().max(1024).nullable().optional(),
});

export type CreateMediaAssetInput = z.infer<typeof createMediaAssetInput>;

export interface MediaAssetRow {
  id: string;
  workspaceId: string;
  storageKey: string;
  mime: string;
  bytes: number;
  checksum: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  renditions: Record<string, string>;
}

function toRow(row: {
  id: string;
  workspaceId: string;
  storageKey: string;
  mime: string;
  bytes: number;
  checksum: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  renditions: unknown;
}): MediaAssetRow {
  return {
    ...row,
    renditions: (row.renditions ?? {}) as Record<string, string>,
  };
}

const SELECTION = {
  id: mediaAssets.id,
  workspaceId: mediaAssets.workspaceId,
  storageKey: mediaAssets.storageKey,
  mime: mediaAssets.mime,
  bytes: mediaAssets.bytes,
  checksum: mediaAssets.checksum,
  width: mediaAssets.width,
  height: mediaAssets.height,
  durationMs: mediaAssets.durationMs,
  renditions: mediaAssets.renditions,
};

export async function findMediaAssetByChecksum(
  db: Executor,
  workspaceId: string,
  checksum: string,
): Promise<MediaAssetRow | null> {
  const [row] = await db
    .select(SELECTION)
    .from(mediaAssets)
    .where(and(eq(mediaAssets.workspaceId, workspaceId), eq(mediaAssets.checksum, checksum)))
    .limit(1);
  return row ? toRow(row) : null;
}

export async function findMediaAssetById(
  db: Executor,
  workspaceId: string,
  id: string,
): Promise<MediaAssetRow | null> {
  const [row] = await db
    .select(SELECTION)
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.workspaceId, workspaceId)))
    .limit(1);
  return row ? toRow(row) : null;
}

/**
 * Inserts a new asset, or returns the existing one on a checksum collision
 * within the workspace (dedupe, PRD ISS-006 test case 2). The unique
 * (workspace_id, checksum) index makes the check race-safe: a concurrent
 * insert of the same checksum hits the constraint and we return the winner.
 */
export async function insertOrGetMediaAsset(
  db: Executor,
  workspaceId: string,
  input: CreateMediaAssetInput,
): Promise<{ asset: MediaAssetRow; deduplicated: boolean }> {
  const parsed = createMediaAssetInput.parse(input);

  const existing = await findMediaAssetByChecksum(db, workspaceId, parsed.checksum);
  if (existing) {
    return { asset: existing, deduplicated: true };
  }

  // No explicit conflict target (ISS-006-F2): the table has two unique indexes,
  // (workspace_id, checksum) and storage_key. Targeting only the former would
  // let a storage_key collision raise instead of dedupe. onConflictDoNothing
  // with no target suppresses ANY unique violation, and the checksum re-lookup
  // below resolves the winner for the dedupe case.
  const inserted = await db
    .insert(mediaAssets)
    .values({
      workspaceId,
      storageKey: parsed.storageKey,
      mime: parsed.mime,
      bytes: parsed.bytes,
      width: parsed.width ?? null,
      height: parsed.height ?? null,
      durationMs: parsed.durationMs ?? null,
      checksum: parsed.checksum,
      originalFilename: parsed.originalFilename ?? null,
    })
    .onConflictDoNothing()
    .returning(SELECTION);

  if (inserted[0]) {
    return { asset: toRow(inserted[0]), deduplicated: false };
  }

  // Conflict suppressed. The dedupe case is a checksum collision, so resolve
  // the existing row by checksum.
  const winner = await findMediaAssetByChecksum(db, workspaceId, parsed.checksum);
  if (!winner) {
    // A storage_key collision with a DIFFERENT checksum landed here: distinct
    // content that happened to draw a colliding server-generated key (astronomic
    // with UUIDs). Surface it rather than silently returning the wrong asset.
    throw new Error(
      'media asset insert conflicted on storage_key with different content; retry with a new key',
    );
  }
  return { asset: winner, deduplicated: true };
}

export async function setRenditions(
  db: Executor,
  workspaceId: string,
  id: string,
  renditions: Record<string, string>,
): Promise<void> {
  await db
    .update(mediaAssets)
    .set({ renditions, updatedAt: new Date() })
    .where(and(eq(mediaAssets.id, id), eq(mediaAssets.workspaceId, workspaceId)));
}
