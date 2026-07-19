# Poslatr, agent instructions

Read `docs/poslatr-v0.1-prd.md` (the specification) and `SECURITY.md` (the binding security policy) before doing anything else. `CONTRIBUTING.md` contains the engineering, security, and review protocol (PRD sections 4 to 7) and is binding on every issue and PR.

## Reference codebase

Postiz (github.com/gitroomhq/postiz-app) is our read-only reference for social platform integration patterns. When a design question needs it, shallow-clone it OUTSIDE this repo: git clone --depth 1 https://github.com/gitroomhq/postiz-app /tmp/postiz-reference. Read it for patterns and edge cases (especially libraries/nestjs-libraries/src/integrations/social/). Never copy, port, or paraphrase its code into this repo - it is AGPL-3.0 and this project must stay clean of derived text. Never clone it inside the workspace or commit any part of it. When a decision borrows an idea, note "pattern reference: postiz <file path>" in the PR description.
