import { z } from 'zod';
import { isValidVaultMasterKey } from './vault-key.js';

const vaultKey = z
  .string()
  .refine(isValidVaultMasterKey, {
    // Never echo the offending value: this message may reach logs.
    message:
      'must be base64 for exactly 32 high-entropy bytes; generate with: openssl rand -base64 32',
  });

const envSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().int().positive(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  MINIO_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Per-provider feature gating (PRD 3.2), as data not code: provider ids
  // appear only as runtime values here, never in a conditional, which is what
  // keeps the provider-agnosticism grep clean by construction.
  ENABLED_PROVIDERS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  VAULT_MASTER_KEY: vaultKey,
  // The version tag written on new encryptions. Bumped when rotating.
  VAULT_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  // Set only while a rotation is in progress, then removed.
  VAULT_MASTER_KEY_PREVIOUS: vaultKey.optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(issues: string) {
    super(`Environment validation failed, refusing to start:\n${issues}`);
    this.name = 'EnvValidationError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new EnvValidationError(issues);
  }
  return result.data;
}
