import { createBaseConfig } from '@poslatr/config/eslint';

export default [
  ...createBaseConfig(import.meta.dirname),
  {
    rules: {
      // PRD ISS-004: credentials are decrypted only in server worker/API
      // processes. The web app must never touch the vault. A unit test in
      // packages/vault enforces the same rule if this config regresses.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@poslatr/vault',
              message:
                'The vault must never be imported from the web app (PRD ISS-004). Decrypt only in the worker/API.',
            },
          ],
        },
      ],
    },
  },
];
