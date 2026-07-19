import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Never pick up compiled test files from the build output.
    exclude: ['node_modules/**', 'dist/**'],
  },
});
