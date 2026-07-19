import { z } from 'zod';
import type { Executor } from '../client.js';
import { auditEvents } from '../schema/audit-events.js';

// Minimal append-only event writer. ISS-010 builds the full audit package
// (typed event catalog, viewer, notification center) on top of this table; the
// worker uses this now to record terminal publish failures as events so a
// notification surface has something to read (PRD ISS-007 "notification event").

export const auditEventInput = z.object({
  actor: z.string().min(1).max(128),
  action: z.string().min(1).max(128),
  entityType: z.string().min(1).max(64),
  entityId: z.uuid().nullable().optional(),
  outcome: z.string().min(1).max(64),
  correlationId: z.string().max(128).nullable().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});

export type AuditEventInput = z.infer<typeof auditEventInput>;

export async function writeAuditEvent(
  db: Executor,
  workspaceId: string,
  input: AuditEventInput,
): Promise<{ id: string }> {
  const parsed = auditEventInput.parse(input);
  const [row] = await db
    .insert(auditEvents)
    .values({
      workspaceId,
      actor: parsed.actor,
      action: parsed.action,
      entityType: parsed.entityType,
      entityId: parsed.entityId ?? null,
      outcome: parsed.outcome,
      correlationId: parsed.correlationId ?? null,
      meta: parsed.meta,
    })
    .returning({ id: auditEvents.id });
  if (!row) {
    throw new Error('audit event insert returned no row');
  }
  return row;
}
