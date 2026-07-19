import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createWorkspace, insertOrGetMediaAsset, type DatabaseHandle } from '@poslatr/db';
import { checksum } from './media.js';

// A fresh content checksum per case, so runs don't collide on prior data.
function uniqueChecksum(): string {
  return checksum(new Uint8Array(randomBytes(16)));
}

// Checksum dedupe (PRD ISS-006 test case 2) is DB behavior, so it lives with a
// live Postgres. Skips without DATABASE_URL; CI provides it.
const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb('media asset checksum dedupe', () => {
  let handle: DatabaseHandle;
  let workspaceId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    handle = connect(databaseUrl as string, { max: 4 });
    workspaceId = (await createWorkspace(handle.db, { name: `media-${Date.now()}` })).id;
    otherWorkspaceId = (await createWorkspace(handle.db, { name: `media-other-${Date.now()}` })).id;
  });

  afterAll(async () => {
    await handle.close();
  });

  function asset(sum: string, key: string) {
    return {
      storageKey: key,
      mime: 'image/png',
      bytes: 1234,
      checksum: sum,
      width: 10,
      height: 10,
    };
  }

  // Storage keys are server-generated UUIDs in production (decidePresign), so
  // each attempt carries a unique key; dedupe is purely on checksum.
  it('returns the existing record on a duplicate checksum, creating no new row', async () => {
    const sum = uniqueChecksum();

    const firstKey = randomUUID();
    const first = await insertOrGetMediaAsset(handle.db, workspaceId, asset(sum, firstKey));
    expect(first.deduplicated).toBe(false);

    const second = await insertOrGetMediaAsset(handle.db, workspaceId, asset(sum, randomUUID()));
    expect(second.deduplicated).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    // The second attempt's key was ignored; the original object is reused.
    expect(second.asset.storageKey).toBe(firstKey);
  });

  it('scopes dedupe per workspace: the same checksum in another workspace is a new asset', async () => {
    const sum = uniqueChecksum();

    const a = await insertOrGetMediaAsset(handle.db, workspaceId, asset(sum, randomUUID()));
    const b = await insertOrGetMediaAsset(handle.db, otherWorkspaceId, asset(sum, randomUUID()));

    expect(b.deduplicated).toBe(false);
    expect(b.asset.id).not.toBe(a.asset.id);
  });

  it('is race-safe: concurrent inserts of one checksum yield a single row', async () => {
    const sum = uniqueChecksum();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        insertOrGetMediaAsset(handle.db, workspaceId, asset(sum, randomUUID())),
      ),
    );

    const ids = new Set(results.map((r) => r.asset.id));
    expect(ids.size).toBe(1);
    // Exactly one insert won; the rest deduplicated.
    expect(results.filter((r) => !r.deduplicated).length).toBe(1);
  });
});
