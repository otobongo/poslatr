import { describe, expect, it } from 'vitest';
import { IllegalStatusTransitionError } from '../errors.js';
import {
  ALL_POST_STATUSES,
  assertLegalPostTransition,
  isLegalPostTransition,
  legalTransitionsFrom,
  type PostStatus,
} from './transitions.js';

// The transition graph this suite pins down. Every pair not listed here is
// asserted illegal below, so the matrix is exhaustive by construction rather
// than by a hand-written list of negatives.
const EXPECTED_LEGAL: Readonly<Record<PostStatus, readonly PostStatus[]>> = {
  draft: ['scheduled', 'cancelled'],
  scheduled: ['publishing', 'cancelled', 'draft'],
  publishing: ['published', 'failed'],
  published: [],
  failed: ['scheduled'],
  cancelled: [],
};

describe('post status transition graph', () => {
  it('matches the expected legal edges exactly', () => {
    for (const from of ALL_POST_STATUSES) {
      expect([...legalTransitionsFrom(from)].sort()).toEqual([...EXPECTED_LEGAL[from]].sort());
    }
  });

  // Exhaustive matrix: all 36 ordered pairs are checked against the expectation.
  it.each(ALL_POST_STATUSES)('classifies every transition out of %s', (from) => {
    for (const to of ALL_POST_STATUSES) {
      const expected = EXPECTED_LEGAL[from].includes(to);
      expect(isLegalPostTransition(from, to)).toBe(expected);
    }
  });

  it('rejects published -> scheduled (PRD ISS-003 test case 2)', () => {
    expect(isLegalPostTransition('published', 'scheduled')).toBe(false);
    expect(() => assertLegalPostTransition('published', 'scheduled')).toThrow(
      IllegalStatusTransitionError,
    );
  });

  it('rejects skipping straight from draft to published', () => {
    expect(() => assertLegalPostTransition('draft', 'published')).toThrow(
      IllegalStatusTransitionError,
    );
  });

  it('rejects reversing publishing back to scheduled', () => {
    expect(() => assertLegalPostTransition('publishing', 'scheduled')).toThrow(
      IllegalStatusTransitionError,
    );
  });

  it('treats terminal states as terminal', () => {
    expect(legalTransitionsFrom('published')).toHaveLength(0);
    expect(legalTransitionsFrom('cancelled')).toHaveLength(0);
  });

  it('rejects self-transitions', () => {
    for (const status of ALL_POST_STATUSES) {
      expect(isLegalPostTransition(status, status)).toBe(false);
    }
  });

  it('carries the from/to pair on the thrown error', () => {
    try {
      assertLegalPostTransition('published', 'draft');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalStatusTransitionError);
      const typed = err as IllegalStatusTransitionError;
      expect(typed.from).toBe('published');
      expect(typed.to).toBe('draft');
      expect(typed.entity).toBe('post');
    }
  });
});
