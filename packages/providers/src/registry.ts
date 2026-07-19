import { capabilitiesSchema, type Provider } from '@poslatr/core';

export class InvalidProviderError extends Error {
  readonly providerId: string;

  constructor(providerId: string, detail: string, options?: ErrorOptions) {
    super(`Provider "${providerId}" failed registration: ${detail}`, options);
    this.name = 'InvalidProviderError';
    this.providerId = providerId;
  }
}

export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`No provider registered with id "${providerId}"`);
    this.name = 'UnknownProviderError';
  }
}

export class ProviderDisabledError extends Error {
  constructor(providerId: string) {
    super(`Provider "${providerId}" is registered but not enabled; add it to ENABLED_PROVIDERS`);
    this.name = 'ProviderDisabledError';
  }
}

const PROVIDER_ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * The provider registry (PRD 3.2). Providers self-register; capability schemas
 * are validated HERE, at registration, so a provider with an invalid
 * declaration fails at boot rather than at first use (ISS-005 test case 1).
 *
 * Enablement is data, not code: callers pass the ENABLED_PROVIDERS list from
 * env, and no provider id ever appears in a conditional anywhere in core.
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>();

  register(provider: Provider): void {
    if (!PROVIDER_ID.test(provider.id)) {
      throw new InvalidProviderError(provider.id, 'id must match /^[a-z][a-z0-9-]{1,31}$/');
    }
    if (this.#providers.has(provider.id)) {
      throw new InvalidProviderError(provider.id, 'a provider with this id is already registered');
    }

    let declared: unknown;
    try {
      declared = provider.capabilities();
    } catch (err) {
      throw new InvalidProviderError(provider.id, 'capabilities() threw during registration', {
        cause: err,
      });
    }
    const parsed = capabilitiesSchema.safeParse(declared);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new InvalidProviderError(provider.id, `invalid capability schema (${issues})`);
    }

    this.#providers.set(provider.id, provider);
  }

  /**
   * Resolves an ENABLED provider. Unknown and disabled ids throw distinct
   * typed errors (ISS-005 test case 2): disabled providers are invisible to
   * the UI and scheduler exactly as if absent, but the error tells an
   * operator which of the two situations they are in.
   */
  get(id: string, enabledIds: readonly string[]): Provider {
    const provider = this.#providers.get(id);
    if (!provider) {
      throw new UnknownProviderError(id);
    }
    if (!enabledIds.includes(id)) {
      throw new ProviderDisabledError(id);
    }
    return provider;
  }

  /** Every registered AND enabled provider, for the UI and scheduler. */
  enabled(enabledIds: readonly string[]): Provider[] {
    return [...this.#providers.values()].filter((p) => enabledIds.includes(p.id));
  }

  /** Registered ids regardless of enablement (diagnostics only). */
  registeredIds(): string[] {
    return [...this.#providers.keys()];
  }
}
