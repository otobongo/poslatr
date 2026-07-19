import { z } from 'zod';
import type { Capabilities } from './capabilities.js';

// The Provider contract (PRD 3.2). Everything a platform integration must
// implement; core never references a concrete provider id.

/** The canonical post shape validate() and publish() consume. */
export const canonicalPostSchema = z.object({
  body: z.object({
    text: z.string(),
  }),
  media: z.array(
    z.object({
      assetId: z.uuid(),
      mime: z.string(),
      bytes: z.number().int().positive(),
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
      durationMs: z.number().int().positive().nullable(),
    }),
  ),
});

export type CanonicalPost = z.infer<typeof canonicalPostSchema>;

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** What beginConnect returns: an OAuth redirect or a credential form spec. */
export type ConnectStart =
  | { kind: 'oauth'; authorizationUrl: string; state: string }
  | {
      kind: 'form';
      fields: Array<{ name: string; label: string; secret: boolean }>;
    };

export interface ConnectContext {
  workspaceId: string;
  /** Fixed server-side callback URL; never request-derived (SECURITY.md 2.12). */
  redirectUri: string;
}

/**
 * Opaque provider credentials. Only ever held transiently in worker/API call
 * scope; persisted exclusively through packages/vault.
 */
export type ProviderCredentials = Record<string, unknown>;

export interface MediaAssetRef {
  assetId: string;
  storageKey: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface RenditionRequest {
  assetId: string;
  renditionName: string;
  maxWidth: number;
  maxHeight: number;
  mime: string;
}

export interface PreparedMedia {
  assetId: string;
  /** Short-TTL signed URL resolved by the media module at publish time. */
  signedUrl: string;
  mime: string;
  altText: string | null;
}

export interface PreparedPost {
  post: CanonicalPost;
  media: PreparedMedia[];
  /** Correlation id flowing API -> job -> provider call (SECURITY.md 2.18). */
  correlationId: string;
}

export interface PublishResult {
  remotePostId: string;
  remoteUrl: string | null;
}

export type RemoteStatus =
  | { state: 'live'; remoteUrl: string | null }
  | { state: 'deleted' }
  | { state: 'unknown' };

export interface ProviderAuth {
  beginConnect(ctx: ConnectContext): Promise<ConnectStart>;
  completeConnect(ctx: ConnectContext, payload: Record<string, unknown>): Promise<ProviderCredentials>;
  refresh(credentials: ProviderCredentials): Promise<ProviderCredentials>;
}

export interface Provider {
  readonly id: string;
  capabilities(): Capabilities;
  readonly auth: ProviderAuth;
  /** Pure: no network, no side effects, same input same output (PRD 3.2). */
  validate(post: CanonicalPost): ValidationResult;
  prepareMedia(assets: MediaAssetRef[]): RenditionRequest[];
  publish(post: PreparedPost, credentials: ProviderCredentials): Promise<PublishResult>;
  status(remoteId: string, credentials: ProviderCredentials): Promise<RemoteStatus>;
}
