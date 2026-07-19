import { describe, expect, it } from 'vitest';
import type { CanonicalPost, ValidationResult } from '@poslatr/core';
import { FakeProvider } from './fake/fake-provider.js';
import type { Transport } from './transport.js';
import {
  checkCapabilityDeclaration,
  checkPublishErrorMapping,
  checkValidatePurity,
  runAllContractChecks,
  type ContractSubject,
} from './testing/harness.js';

const fakeSubject: ContractSubject = {
  name: 'FakeProvider',
  createProvider: (transport: Transport) => new FakeProvider({ transport }),
};

describe('FakeProvider passes the contract harness (PRD ISS-005)', () => {
  it('declares a valid capability schema', () => {
    const result = checkCapabilityDeclaration(fakeSubject);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('validate() is pure under property-based inputs', async () => {
    const result = await checkValidatePurity(fakeSubject);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('publish() maps every upstream failure onto the taxonomy', async () => {
    const result = await checkPublishErrorMapping(fakeSubject);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('passes the aggregate check', async () => {
    const result = await runAllContractChecks(fakeSubject);
    expect(result.ok).toBe(true);
  });
});

// ISS-005 test case 3: the harness must FAIL a deliberately broken provider.
// Each fixture breaks exactly one contract obligation.

class NetworkValidateProvider extends FakeProvider {
  override validate(post: CanonicalPost): ValidationResult {
    // The forbidden act: network I/O inside validate(). The harness's fetch
    // spy rejects, so swallow to keep the method from throwing; the spy call
    // count is what convicts us.
    void fetch('https://example.invalid/validate').catch(() => undefined);
    return super.validate(post);
  }
}

class TransportValidateProvider extends FakeProvider {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    super({ transport });
    this.#transport = transport;
  }

  override validate(post: CanonicalPost): ValidationResult {
    void this.#transport
      .request({ method: 'GET', url: 'https://example.invalid/check' })
      .catch(() => undefined);
    return super.validate(post);
  }
}

class NondeterministicValidateProvider extends FakeProvider {
  #flip = false;

  override validate(post: CanonicalPost): ValidationResult {
    this.#flip = !this.#flip;
    const base = super.validate(post);
    return this.#flip ? base : { ok: !base.ok, issues: base.issues };
  }
}

class SwallowingPublishProvider extends FakeProvider {
  override async publish(): Promise<{ remotePostId: string; remoteUrl: string | null }> {
    // Breaks error mapping: reports success no matter what upstream said.
    return Promise.resolve({ remotePostId: 'lie', remoteUrl: null });
  }
}

describe('the harness fails deliberately broken providers (ISS-005 test case 3)', () => {
  it('convicts validate() doing fetch I/O', async () => {
    const result = await checkValidatePurity({
      name: 'network-validate',
      createProvider: (t) => new NetworkValidateProvider({ transport: t }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/fetch call/);
  });

  it('convicts validate() using the injected transport', async () => {
    const result = await checkValidatePurity({
      name: 'transport-validate',
      createProvider: (t) => new TransportValidateProvider(t),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/transport call/);
  });

  it('convicts a nondeterministic validate()', async () => {
    const result = await checkValidatePurity({
      name: 'nondeterministic-validate',
      createProvider: (t) => new NondeterministicValidateProvider({ transport: t }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/nondeterministic/);
  });

  it('convicts a publish() that swallows upstream failures', async () => {
    const result = await checkPublishErrorMapping({
      name: 'swallowing-publish',
      createProvider: (t) => new SwallowingPublishProvider({ transport: t }),
    });
    expect(result.ok).toBe(false);
    // Every non-success expectation fails: 429/5xx/401/422/network all lied.
    expect(result.failures.length).toBeGreaterThanOrEqual(5);
  });

  it('convicts an invalid capability declaration', () => {
    const result = checkCapabilityDeclaration({
      name: 'bad-caps',
      createProvider: (t) =>
        new FakeProvider({
          transport: t,
          capabilities: {
            contentTypes: ['text'],
            maxCharacters: 0,
            maxMediaCount: -3,
            allowedMimeTypes: ['not a mime'],
            mediaConstraints: { maxBytes: 0, maxDurationMs: null, allowedAspectRatios: [] },
            rateWindows: [],
            // Cast: deliberately invalid values that still satisfy the TS type.
          } as never,
        }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });
});
