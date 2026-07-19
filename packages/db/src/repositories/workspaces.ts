import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../client.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';

export const createWorkspaceInput = z.object({
  name: z.string().min(1).max(200),
});

export async function createWorkspace(
  db: Executor,
  input: z.infer<typeof createWorkspaceInput>,
): Promise<{ id: string; name: string }> {
  const parsed = createWorkspaceInput.parse(input);
  const [row] = await db
    .insert(workspaces)
    .values({ name: parsed.name })
    .returning({ id: workspaces.id, name: workspaces.name });

  if (!row) {
    throw new Error('Insert returned no row');
  }
  return row;
}

/**
 * Loads the session's own workspace.
 *
 * ISS-003-F2: this was previously findWorkspaceById(db, id), which let any
 * caller holding an arbitrary UUID read that workspace. Taking exactly one id,
 * always the session's, makes that misuse unrepresentable rather than merely
 * discouraged (SECURITY.md 2.6).
 */
export async function findWorkspaceForSession(
  db: Executor,
  sessionWorkspaceId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, sessionWorkspaceId))
    .limit(1);

  return row ?? null;
}

// passwordHash is intentionally not accepted here: ISS-003 creates user rows
// without credentials, and all credential handling lands in ISS-009 (PRD 4.3
// stop condition on auth changes).
export const createUserInput = z.object({
  email: z.email().max(320),
  displayName: z.string().min(1).max(200),
});

export async function createUser(
  db: Executor,
  workspaceId: string,
  input: z.infer<typeof createUserInput>,
): Promise<{ id: string; email: string }> {
  const parsed = createUserInput.parse(input);
  const [row] = await db
    .insert(users)
    .values({
      workspaceId,
      email: parsed.email,
      displayName: parsed.displayName,
    })
    .returning({ id: users.id, email: users.email });

  if (!row) {
    throw new Error('Insert returned no row');
  }
  return row;
}
