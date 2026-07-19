import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('required verification-gate scripts exist in package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const script of ['typecheck', 'lint', 'test', 'build']) {
    assert.ok(pkg.scripts?.[script], `missing script: ${script}`);
  }
});

test('governance documents are present', async () => {
  for (const file of ['../SECURITY.md', '../CONTRIBUTING.md', '../.github/pull_request_template.md']) {
    const content = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(content.length > 0, `${file} is empty`);
  }
});
