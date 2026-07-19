import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/poslatr',
  REDIS_URL: 'redis://localhost:6379',
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_ACCESS_KEY: 'minioadmin',
  MINIO_SECRET_KEY: 'minioadmin',
  MINIO_BUCKET: 'poslatr-media',
  MINIO_USE_SSL: 'false',
  NODE_ENV: 'test',
};

function without(field: keyof typeof validEnv): Record<string, string> {
  const rest = { ...validEnv };
  delete rest[field];
  return rest;
}

describe('loadEnv', () => {
  it('parses a fully populated valid environment', () => {
    const env = loadEnv(validEnv);
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.MINIO_PORT).toBe(9000);
    expect(env.MINIO_USE_SSL).toBe(false);
  });

  it('refuses to start when a required var is missing', () => {
    expect(() => loadEnv(without('DATABASE_URL'))).toThrow(EnvValidationError);
  });

  it('refuses to start when a var is malformed', () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('names the missing field in the error', () => {
    try {
      loadEnv(without('REDIS_URL'));
      throw new Error('expected loadEnv to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as Error).message).toContain('REDIS_URL');
    }
  });

  it('defaults NODE_ENV to development when unset', () => {
    expect(loadEnv(without('NODE_ENV')).NODE_ENV).toBe('development');
  });
});
