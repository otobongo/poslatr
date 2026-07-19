import { IllegalStatusTransitionError } from '../errors.js';

export type PostStatus =
  | 'draft'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled';

export type PostTargetStatus = PostStatus;

// The complete legal transition graph, per SECURITY.md 2.3:
// draft -> scheduled -> publishing -> published | failed, plus
// scheduled -> cancelled. No skipping, and terminal states stay terminal.
//
// Four edges extend the minimum spine in SECURITY.md 2.3. All four are
// deliberate, and documented here because the graph is the de-facto authority
// on post lifecycle for every downstream issue (ISS-003-F10):
//
//   scheduled -> draft      unschedule; the exact inverse of draft -> scheduled
//   draft     -> cancelled  discard an unscheduled draft without deleting it
//   failed    -> scheduled  user-initiated retry, required by the ISS-009
//                           failure UX ("failed posts expose reason + retry")
//   publishing -> scheduled stale-claim recovery ONLY. A worker killed between
//                           claim and completion would otherwise strand the row
//                           forever with no legal exit (ISS-003-F3). This edge
//                           is reachable exclusively through
//                           reclaimStalePostTarget(), which requires an expired
//                           lease; ordinary callers cannot reverse an active
//                           publish.
const LEGAL_POST_TRANSITIONS: Readonly<Record<PostStatus, readonly PostStatus[]>> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['publishing', 'cancelled', 'draft'],
  publishing: ['published', 'failed', 'scheduled'],
  published: [],
  failed: ['scheduled'],
  cancelled: [],
};

export function isLegalPostTransition(from: PostStatus, to: PostStatus): boolean {
  return LEGAL_POST_TRANSITIONS[from].includes(to);
}

export function assertLegalPostTransition(from: PostStatus, to: PostStatus): void {
  if (!isLegalPostTransition(from, to)) {
    throw new IllegalStatusTransitionError('post', from, to);
  }
}

export function isLegalPostTargetTransition(from: PostTargetStatus, to: PostTargetStatus): boolean {
  return isLegalPostTransition(from, to);
}

export function assertLegalPostTargetTransition(
  from: PostTargetStatus,
  to: PostTargetStatus,
): void {
  if (!isLegalPostTargetTransition(from, to)) {
    throw new IllegalStatusTransitionError('post target', from, to);
  }
}

export function legalTransitionsFrom(from: PostStatus): readonly PostStatus[] {
  return LEGAL_POST_TRANSITIONS[from];
}

export const ALL_POST_STATUSES: readonly PostStatus[] = [
  'draft',
  'scheduled',
  'publishing',
  'published',
  'failed',
  'cancelled',
];
