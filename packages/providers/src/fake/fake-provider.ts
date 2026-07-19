import {
  AuthExpiredError,
  RetryableProviderError,
  TerminalProviderError,
  type Capabilities,
  type CanonicalPost,
  type ConnectContext,
  type ConnectStart,
  type MediaAssetRef,
  type PreparedPost,
  type Provider,
  type ProviderCredentials,
  type PublishResult,
  type RemoteStatus,
  type RenditionRequest,
  type ValidationIssue,
  type ValidationResult,
} from '@poslatr/core';
import type { Transport } from '../transport.js';

export const FAKE_PROVIDER_ID = 'fake';

const DEFAULT_CAPABILITIES: Capabilities = {
  contentTypes: ['text', 'image'],
  maxCharacters: 500,
  maxMediaCount: 4,
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
  mediaConstraints: {
    maxBytes: 8 * 1024 * 1024,
    maxDurationMs: null,
    allowedAspectRatios: [],
  },
  rateWindows: [{ windowMs: 300_000, maxRequests: 300 }],
};

/**
 * The reference Provider implementation (PRD ISS-005): passes the contract
 * harness, doubles as the scheduler's test provider in ISS-007, and registers
 * as a second provider in ISS-011's agnosticism scenario. Capabilities are
 * injectable so UI tests can exercise capability-driven rendering.
 */
export class FakeProvider implements Provider {
  readonly id = FAKE_PROVIDER_ID;
  readonly #capabilities: Capabilities;
  readonly #transport: Transport;

  constructor(options: { transport: Transport; capabilities?: Capabilities }) {
    this.#transport = options.transport;
    this.#capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  }

  capabilities(): Capabilities {
    return this.#capabilities;
  }

  readonly auth = {
    beginConnect: (ctx: ConnectContext): Promise<ConnectStart> =>
      Promise.resolve({
        kind: 'oauth' as const,
        authorizationUrl: `https://fake.invalid/oauth/authorize?redirect=${encodeURIComponent(ctx.redirectUri)}`,
        state: ctx.workspaceId,
      }),
    completeConnect: (
      _ctx: ConnectContext,
      payload: Record<string, unknown>,
    ): Promise<ProviderCredentials> => Promise.resolve({ accessToken: payload.code ?? 'fake-token' }),
    refresh: (credentials: ProviderCredentials): Promise<ProviderCredentials> =>
      Promise.resolve(credentials),
  };

  // Pure by construction: reads only the post and the declared capabilities.
  validate(post: CanonicalPost): ValidationResult {
    const caps = this.#capabilities;
    const issues: ValidationIssue[] = [];

    if (post.body.text.length > caps.maxCharacters) {
      issues.push({
        field: 'body.text',
        message: `exceeds ${caps.maxCharacters} characters`,
      });
    }
    if (post.media.length > caps.maxMediaCount) {
      issues.push({ field: 'media', message: `more than ${caps.maxMediaCount} attachments` });
    }
    if (post.body.text.length === 0 && post.media.length === 0) {
      issues.push({ field: 'body.text', message: 'post is empty' });
    }
    for (const [index, item] of post.media.entries()) {
      if (!caps.allowedMimeTypes.includes(item.mime)) {
        issues.push({ field: `media[${index}].mime`, message: `unsupported type ${item.mime}` });
      }
      if (item.bytes > caps.mediaConstraints.maxBytes) {
        issues.push({
          field: `media[${index}].bytes`,
          message: `exceeds ${caps.mediaConstraints.maxBytes} bytes`,
        });
      }
    }

    return { ok: issues.length === 0, issues };
  }

  prepareMedia(assets: MediaAssetRef[]): RenditionRequest[] {
    return assets.map((asset) => ({
      assetId: asset.assetId,
      renditionName: 'fake-standard',
      maxWidth: 1600,
      maxHeight: 1600,
      mime: asset.mime,
    }));
  }

  async publish(post: PreparedPost, _credentials: ProviderCredentials): Promise<PublishResult> {
    let response;
    try {
      response = await this.#transport.request({
        method: 'POST',
        url: 'https://fake.invalid/api/v1/statuses',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: post.post.body.text }),
      });
    } catch (err) {
      // Network failures (DNS, reset, timeout) are retryable per the taxonomy.
      throw new RetryableProviderError(this.id, 'network failure reaching upstream', {
        cause: err,
      });
    }
    return this.#mapResponse(response.status, response.body);
  }

  async status(remoteId: string, _credentials: ProviderCredentials): Promise<RemoteStatus> {
    const response = await this.#transport.request({
      method: 'GET',
      url: `https://fake.invalid/api/v1/statuses/${encodeURIComponent(remoteId)}`,
    });
    if (response.status === 404) return { state: 'deleted' };
    if (response.status >= 200 && response.status < 300) {
      return { state: 'live', remoteUrl: null };
    }
    return { state: 'unknown' };
  }

  // The mapping the harness certifies (PRD 3.3 item 5 / ISS-005 taxonomy).
  #mapResponse(status: number, body: string): PublishResult {
    if (status === 401) {
      throw new AuthExpiredError(this.id, 'authentication rejected');
    }
    if (status === 429 || status >= 500) {
      throw new RetryableProviderError(this.id, `upstream returned ${status}`);
    }
    if (status >= 400) {
      throw new TerminalProviderError(this.id, `upstream rejected the post (${status})`);
    }
    try {
      const parsed: unknown = JSON.parse(body);
      const shaped = parsed as { id?: unknown; url?: unknown };
      if (typeof shaped.id !== 'string') {
        throw new Error('missing id');
      }
      return {
        remotePostId: shaped.id,
        remoteUrl: typeof shaped.url === 'string' ? shaped.url : null,
      };
    } catch {
      throw new TerminalProviderError(this.id, 'upstream returned an unparseable success body');
    }
  }
}
