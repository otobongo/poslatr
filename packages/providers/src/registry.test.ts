import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake/fake-provider.js';
import {
  InvalidProviderError,
  ProviderDisabledError,
  ProviderRegistry,
  UnknownProviderError,
} from './registry.js';
import { RecordingTransport } from './testing/harness.js';

function fake(): FakeProvider {
  return new FakeProvider({ transport: new RecordingTransport() });
}

describe('ProviderRegistry', () => {
  it('registers a provider with a valid capability schema', () => {
    const registry = new ProviderRegistry();
    registry.register(fake());
    expect(registry.registeredIds()).toEqual(['fake']);
  });

  it('rejects an invalid capability schema at registration (ISS-005 test case 1)', () => {
    const registry = new ProviderRegistry();
    const broken = new FakeProvider({
      transport: new RecordingTransport(),
      // Negative char limit: structurally a Capabilities, semantically invalid.
      capabilities: {
        contentTypes: ['text'],
        maxCharacters: -1,
        maxMediaCount: 4,
        allowedMimeTypes: [],
        mediaConstraints: { maxBytes: 1, maxDurationMs: null, allowedAspectRatios: [] },
        rateWindows: [],
      },
    });

    expect(() => registry.register(broken)).toThrow(InvalidProviderError);
    expect(registry.registeredIds()).toEqual([]);
  });

  it('rejects a capabilities() that throws', () => {
    const registry = new ProviderRegistry();
    const throwing = fake();
    Object.defineProperty(throwing, 'capabilities', {
      value: () => {
        throw new Error('boom');
      },
    });

    expect(() => registry.register(throwing)).toThrow(InvalidProviderError);
  });

  it('rejects duplicate registration', () => {
    const registry = new ProviderRegistry();
    registry.register(fake());
    expect(() => registry.register(fake())).toThrow(InvalidProviderError);
  });

  it('rejects malformed provider ids', () => {
    const registry = new ProviderRegistry();
    const bad = fake();
    Object.defineProperty(bad, 'id', { value: 'Not Valid!' });
    expect(() => registry.register(bad)).toThrow(InvalidProviderError);
  });

  describe('feature-flag gating (ISS-005 test case 2)', () => {
    it('a disabled provider is invisible to enabled() and get() throws typed', () => {
      const registry = new ProviderRegistry();
      registry.register(fake());

      // Registered but not in the enabled list: invisible to UI and scheduler.
      expect(registry.enabled([])).toEqual([]);
      expect(() => registry.get('fake', [])).toThrow(ProviderDisabledError);
    });

    it('an enabled provider resolves', () => {
      const registry = new ProviderRegistry();
      registry.register(fake());

      expect(registry.enabled(['fake'])).toHaveLength(1);
      expect(registry.get('fake', ['fake']).id).toBe('fake');
    });

    it('an unknown provider throws a distinct typed error', () => {
      const registry = new ProviderRegistry();
      expect(() => registry.get('nonexistent', ['nonexistent'])).toThrow(UnknownProviderError);
    });

    it('enablement is data: ids in the list but unregistered are simply absent', () => {
      const registry = new ProviderRegistry();
      registry.register(fake());
      expect(registry.enabled(['fake', 'ghost']).map((p) => p.id)).toEqual(['fake']);
    });
  });
});
