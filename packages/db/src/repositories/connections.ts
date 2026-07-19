import { and, eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { connections } from '../schema/connections.js';

export type ConnectionHealth = 'ok' | 'expiring' | 'broken';

export interface ConnectionRow {
  id: string;
  workspaceId: string;
  providerId: string;
  displayName: string;
  credentialsRef: string | null;
  health: ConnectionHealth;
}

export async function findConnectionById(
  db: Executor,
  workspaceId: string,
  id: string,
): Promise<ConnectionRow | null> {
  const [row] = await db
    .select({
      id: connections.id,
      workspaceId: connections.workspaceId,
      providerId: connections.providerId,
      displayName: connections.displayName,
      credentialsRef: connections.credentialsRef,
      health: connections.health,
    })
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

/**
 * Marks a connection's health. ISS-007 sets `broken` on AuthExpiredError so the
 * UI can prompt a reconnect; this is connection state, not credential material.
 */
export async function setConnectionHealth(
  db: Executor,
  workspaceId: string,
  id: string,
  health: ConnectionHealth,
): Promise<void> {
  await db
    .update(connections)
    .set({ health, updatedAt: new Date() })
    .where(and(eq(connections.id, id), eq(connections.workspaceId, workspaceId)));
}
