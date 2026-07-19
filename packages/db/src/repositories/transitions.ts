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
// scheduled -> cancelled. No skipping, no reversing.
//
// failed -> scheduled is permitted deliberately: it is the user-initiated retry
// path surfaced in the ISS-009 failure UX. Every other backward edge is closed.
const LEGAL_POST_TRANSITIONS: Readonly<Record<PostStatus, readonly PostStatus[]>> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['publishing', 'cancelled', 'draft'],
  publishing: ['published', 'failed'],
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
