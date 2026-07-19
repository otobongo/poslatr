import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// PRD ISS-004: nothing in apps/web may import the vault. Credentials are
// decrypted only in the worker/API server processes. An ESLint
// no-restricted-imports rule enforces this at lint time; this test enforces it
// even if the lint config regresses.

const WEB_ROOT = resolve(import.meta.dirname, '../../../apps/web');
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IGNORED_DIRS = new Set(['node_modules', '.next', 'dist', '.turbo', 'coverage']);

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        files.push(...collectSourceFiles(join(dir, entry.name)));
      }
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

describe('vault isolation from the web app (PRD ISS-004)', () => {
  it('no file in apps/web imports @poslatr/vault', () => {
    const files = collectSourceFiles(WEB_ROOT);
    expect(files.length).toBeGreaterThan(0);

    // Match real import forms only (static import/export-from, require, dynamic
    // import), not any mention of the string: the web app's own ESLint rule
    // banning the import necessarily names the package.
    const importsVault =
      /(?:from\s*['"]@poslatr\/vault|require\(\s*['"]@poslatr\/vault|import\(\s*['"]@poslatr\/vault|^\s*import\s*['"]@poslatr\/vault)/m;
    const offenders = files.filter((file) => importsVault.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('apps/web package.json does not depend on the vault', () => {
    const pkg = JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@poslatr/vault']).toBeUndefined();
    expect(pkg.devDependencies?.['@poslatr/vault']).toBeUndefined();
  });
});
