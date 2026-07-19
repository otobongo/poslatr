import fc from 'fast-check';
import {
  AuthExpiredError,
  capabilitiesSchema,
  RetryableProviderError,
  TerminalProviderError,
  type CanonicalPost,
  type PreparedPost,
  type Provider,
} from '@poslatr/core';
import type { Transport, TransportRequest, TransportResponse } from '../transport.js';

// The reusable provider contract harness (PRD ISS-005): every provider, present
// and future, must pass these checks. They are plain functions returning
// results (not test assertions) so the harness itself is testable — the meta
// test proves a deliberately broken provider FAILS.

export interface ContractSubject {
  name: string;
  /** Must build a fresh provider whose ONLY network path is this transport. */
  createProvider(transport: Transport): Provider;
}

export interface CheckResult {
  ok: boolean;
  failures: string[];
}

/** A transport that records every call and returns a scripted response. */
export class RecordingTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  #script: Array<TransportResponse | Error>;

  constructor(script: Array<TransportResponse | Error> = []) {
    this.#script = script;
  }

  request(req: TransportRequest): Promise<TransportResponse> {
    this.calls.push(req);
    const next = this.#script.shift();
    if (next === undefined) {
      return Promise.reject(new Error('RecordingTransport: no scripted response left'));
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  }
}

export function ok(body: string): TransportResponse {
  return { status: 200, headers: {}, body };
}

export function httpStatus(status: number, body = '{}'): TransportResponse {
  return { status, headers: {}, body };
}

const mediaArb = fc.record({
  assetId: fc.uuid(),
  mime: fc.constantFrom('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/pdf'),
  bytes: fc.integer({ min: 1, max: 64 * 1024 * 1024 }),
  width: fc.option(fc.integer({ min: 1, max: 8000 }), { nil: null }),
  height: fc.option(fc.integer({ min: 1, max: 8000 }), { nil: null }),
  durationMs: fc.option(fc.integer({ min: 1, max: 600_000 }), { nil: null }),
});

const canonicalPostArb: fc.Arbitrary<CanonicalPost> = fc.record({
  body: fc.record({ text: fc.string({ maxLength: 2000 }) }),
  media: fc.array(mediaArb, { maxLength: 8 }),
});

/** Check 1: the declared capability schema is valid (ISS-005 test case 1). */
export function checkCapabilityDeclaration(subject: ContractSubject): CheckResult {
  const failures: string[] = [];
  const provider = subject.createProvider(new RecordingTransport());

  let declared: unknown;
  try {
    declared = provider.capabilities();
  } catch (err) {
    return { ok: false, failures: [`capabilities() threw: ${String(err)}`] };
  }
  const parsed = capabilitiesSchema.safeParse(declared);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      failures.push(`capabilities.${issue.path.join('.')}: ${issue.message}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Check 2: validate() is pure (ISS-005 test case 3's target). Property-based
 * inputs; network spies on both the injected transport and global fetch; and a
 * determinism check (same input twice must yield identical results).
 */
export async function checkValidatePurity(
  subject: ContractSubject,
  options: { runs?: number } = {},
): Promise<CheckResult> {
  const failures: string[] = [];
  const transport = new RecordingTransport();
  const provider = subject.createProvider(transport);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.reject(new Error('validate() must not perform network I/O'));
  });

  try {
    const details = await fc.check(
      fc.asyncProperty(canonicalPostArb, (post) => {
        const first = provider.validate(post);
        const second = provider.validate(post);
        if (typeof first.ok !== 'boolean' || !Array.isArray(first.issues)) {
          throw new Error('validate() returned a malformed ValidationResult');
        }
        if (JSON.stringify(first) !== JSON.stringify(second)) {
          throw new Error('validate() is nondeterministic for an identical input');
        }
        return Promise.resolve();
      }),
      { numRuns: options.runs ?? 100 },
    );
    if (details.failed) {
      // Surface the property's own error text, not fast-check's summary,
      // so harness consumers see WHAT broke, with the counterexample after.
      const cause =
        details.errorInstance instanceof Error
          ? details.errorInstance.message
          : 'unknown property failure';
      failures.push(
        `property check failed: ${cause} (counterexample: ${JSON.stringify(details.counterexample)})`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  if (fetchCalls > 0) {
    failures.push(`validate() performed ${fetchCalls} fetch call(s); it must be pure`);
  }
  if (transport.calls.length > 0) {
    failures.push(
      `validate() performed ${transport.calls.length} transport call(s); it must be pure`,
    );
  }
  return { ok: failures.length === 0, failures };
}

const CONTRACT_POST: PreparedPost = {
  post: { body: { text: 'contract harness post' }, media: [] },
  media: [],
  correlationId: 'contract-harness',
};

/**
 * Check 3: publish() maps upstream failures onto the shared error taxonomy via
 * the injected transport. 429 and 5xx retryable, 401 auth-expired, 422
 * terminal, transport rejection retryable, and a scripted success returns a
 * remote id.
 */
export async function checkPublishErrorMapping(subject: ContractSubject): Promise<CheckResult> {
  const failures: string[] = [];

  const expectations: Array<{
    label: string;
    response: TransportResponse | Error;
    assert: (outcome: { threw: unknown } | { result: unknown }) => string | null;
  }> = [
    {
      label: '429 -> RetryableProviderError',
      response: httpStatus(429),
      assert: (o) =>
        'threw' in o && o.threw instanceof RetryableProviderError
          ? null
          : 'expected RetryableProviderError',
    },
    {
      label: '500 -> RetryableProviderError',
      response: httpStatus(500),
      assert: (o) =>
        'threw' in o && o.threw instanceof RetryableProviderError
          ? null
          : 'expected RetryableProviderError',
    },
    {
      label: '503 -> RetryableProviderError',
      response: httpStatus(503),
      assert: (o) =>
        'threw' in o && o.threw instanceof RetryableProviderError
          ? null
          : 'expected RetryableProviderError',
    },
    {
      label: '401 -> AuthExpiredError',
      response: httpStatus(401),
      assert: (o) =>
        'threw' in o && o.threw instanceof AuthExpiredError ? null : 'expected AuthExpiredError',
    },
    {
      label: '422 -> TerminalProviderError',
      response: httpStatus(422),
      assert: (o) =>
        'threw' in o && o.threw instanceof TerminalProviderError
          ? null
          : 'expected TerminalProviderError',
    },
    {
      label: 'network failure -> RetryableProviderError',
      response: new Error('ECONNRESET'),
      assert: (o) =>
        'threw' in o && o.threw instanceof RetryableProviderError
          ? null
          : 'expected RetryableProviderError',
    },
    {
      label: 'success -> PublishResult with remote id',
      response: ok(JSON.stringify({ id: 'remote-123', url: 'https://fake.invalid/p/remote-123' })),
      assert: (o) => {
        if (!('result' in o)) return 'expected publish to succeed';
        const r = o.result as { remotePostId?: unknown };
        return typeof r.remotePostId === 'string' ? null : 'missing remotePostId';
      },
    },
  ];

  for (const expectation of expectations) {
    const transport = new RecordingTransport([expectation.response]);
    const provider = subject.createProvider(transport);
    let outcome: { threw: unknown } | { result: unknown };
    try {
      outcome = { result: await provider.publish(CONTRACT_POST, { accessToken: 'x' }) };
    } catch (err) {
      outcome = { threw: err };
    }
    const failure = expectation.assert(outcome);
    if (failure !== null) {
      failures.push(`${expectation.label}: ${failure}`);
    }
  }

  return { ok: failures.length === 0, failures };
}

export async function runAllContractChecks(subject: ContractSubject): Promise<CheckResult> {
  const results = [
    checkCapabilityDeclaration(subject),
    await checkValidatePurity(subject),
    await checkPublishErrorMapping(subject),
  ];
  return {
    ok: results.every((r) => r.ok),
    failures: results.flatMap((r) => r.failures),
  };
}
