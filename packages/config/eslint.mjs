import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// tsconfigRootDir must be the calling package's own directory (import.meta.dirname
// from that package's eslint.config.mjs), not this shared config package's directory,
// or typescript-eslint's projectService cannot find the package's tsconfig.json.
export function createBaseConfig(tsconfigRootDir) {
  return tseslint.config(
    { ignores: ['node_modules/', 'dist/', '.next/', '.turbo/', 'coverage/'] },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          // eslint.config.mjs itself sits outside every tsconfig.json's include;
          // allowDefaultProject lets typescript-eslint lint it without type info.
          projectService: {
            allowDefaultProject: ['eslint.config.mjs'],
          },
          tsconfigRootDir,
        },
      },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-explicit-any': 'error',
        // Interface implementations often ignore parameters; the leading
        // underscore is the explicit "unused on purpose" marker.
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            // Keep unused-catch detection on; opt out per-binding with `_`
            // (ISS-005-F4) rather than disabling it wholesale.
            caughtErrorsIgnorePattern: '^_',
          },
        ],
      },
    },
  );
}
