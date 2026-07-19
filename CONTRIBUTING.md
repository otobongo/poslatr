# Contributing to Poslatr

Sections 4 to 7 of docs/poslatr-v0.1-prd.md, reproduced verbatim. These are gates, not suggestions.

---

## 4. Engineering protocol (binding for every issue)

Adapted from the owner's CLAUDE.md senior engineering framework. These are gates, not suggestions.

### 4.1 Anti-hallucination protocol

- Read a file before editing it. Cite file paths when referencing code.
- Never assert an API's shape from memory. Check the installed package's types or docs (use context7 MCP when available in the Claude Code session).
- Run commands instead of claiming outcomes. Quote actual output and actual error messages.
- Label every claim in your final report as **verified** (you ran it) or **assumed** (you didn't). Assumed claims on acceptance criteria are not acceptance.

### 4.2 Verification gates (per issue, in order, all mandatory)

1. `pnpm typecheck` clean
2. `pnpm lint` clean
3. `pnpm test` green, including new tests for this issue
4. `pnpm build` succeeds
5. Feature exercised end to end (curl, script, or Playwright), output pasted into the issue

### 4.3 Stop conditions (halt and ask the owner)

- Any schema migration
- Any change to auth, vault, or credential handling
- Adding a dependency not named in this PRD
- Any destructive operation (data deletion, force push, dropping tables)
- Any deviation from the approved plan for the current issue

### 4.4 One issue at a time

Work strictly in issue order unless the dependency graph allows and the owner approves parallel work. Per issue: branch `feat/ISS-XXX-slug`, conventional commits, PR referencing the issue, review pass (section 6), owner merge. Never start ISS-N+1 with ISS-N unmerged.

---

## 5. Security principles (binding)

Condensed from the owner's security policy. The full consolidated policy exists as `SECURITY.md` (delivered alongside this PRD, extracted from the owner's Security Audit Instructions, Security Scan Prompt, and security-test skill) and is committed to the repo in ISS-001; it is the authoritative document, including the per-issue and full scan protocol, the exception process, and the `psl_` table naming convention. The checklist below is the per-PR enforcement subset.

### 5.1 Non-negotiables

1. **Secrets:** No secret in code, logs, or client bundles. Env vars validated by zod schema at boot; missing secret = refuse to start. `.env` gitignored, `.env.example` maintained.
2. **Token vault:** Platform credentials encrypted at rest, AES-256-GCM via libsodium sealed boxes, key from env (VPS) with KMS as a future swap. Decryption only inside `packages/vault`, only in the worker/API process, never serialized to client or logs. Vault package exports `encrypt`, `decrypt`, `rotate` and nothing else.
3. **Injection:** Drizzle parameterized queries only. Raw SQL requires owner approval (stop condition).
4. **Input validation:** Zod on every API route, queue payload, and provider response. Reject, don't sanitize-and-continue.
5. **AuthN/AuthZ:** v0.1 is single-user but auth is real: session-based login (Argon2id password hash), CSRF protection, every API route asserts session + workspace ownership. No route ships unauthenticated except health check.
6. **SSRF:** The media fetcher and any URL the server retrieves must pass an allowlist/deny-private-ranges check (no 169.254.0.0/16, 10/8, 172.16/12, 192.168/16, localhost). Signed URL generation never accepts caller-supplied hosts.
7. **Signed URLs:** Media served via short-TTL signed URLs (15 min default). Bucket is private. No public bucket policies, ever.
8. **Rate limiting:** API routes rate-limited via Redis. Provider calls respect declared rate windows from capabilities.
9. **Audit:** Every state-changing action (connect, schedule, publish, cancel, credential refresh) writes a structured audit event: actor, action, entity, timestamp, outcome. Audit writes are append-only.
10. **Dependencies:** Lockfile committed. `pnpm audit` in CI, high/critical findings block merge. New deps require justification in PR.
11. **Headers/transport:** HTTPS only (Coolify/Traefik), HSTS, CSP, X-Content-Type-Options, frame-ancestors none.
12. **Error hygiene:** Provider errors logged server-side with correlation IDs; client sees generic messages. Stack traces never cross the API boundary.

### 5.2 Per-PR security checklist (copy into every PR description)

```
- [ ] No secrets in diff, logs, or client code
- [ ] All new inputs zod-validated
- [ ] All new routes assert auth + workspace ownership
- [ ] No raw SQL / no string-built queries
- [ ] No new public storage access; signed URLs only
- [ ] External fetches SSRF-guarded
- [ ] State changes write audit events
- [ ] New deps justified, pnpm audit clean
- [ ] Errors: generic client-side, detailed server-side with correlation ID
```

Any unchecked item without a written exception (owner-approved, with compensating control and remediation date) blocks merge.

---

## 6. Code review protocol (binding)

Per the owner's gated review workflow:

1. **Reviewer model:** every PR gets a review pass by **Claude Fable 5** acting as principal engineer, in a fresh session with no implementation context (cold review).
2. **Scored verdict:** 1 to 5 on Security, Architecture, Correctness, Test quality. Any dimension ≤ 3 blocks merge.
3. **Finding IDs:** findings numbered `ISS-XXX-F1, F2, ...`. Every fix commit references its finding ID. No unreferenced fixes, no unfixed findings without owner-approved exceptions.
4. **Review checklist:** section 5.2 checklist verified item by item, plus: provider-agnosticism grep check (3.2), capability-schema-driven validation, idempotency on any queue consumer touched.
5. **Score ≤ 2:** do not fix incrementally. Escalate to the owner for a first-principles rewrite decision per the rewrite workflow.

---

## 7. Model delegation matrix

Owner directive: hard tasks to Fable 5; the rest split between Opus 4.8 and Sonnet 5 by complexity.

| Tier | Model | Assigned work |
|---|---|---|
| Hard (novel design, security-critical, concurrency) | **Claude Fable 5** | ISS-004 vault, ISS-005 provider contract, ISS-007 scheduler; all cold code reviews |
| Complex (multi-module features, integration) | **Claude Opus 4.8** | ISS-003 schema, ISS-006 media, ISS-009 compose UI, ISS-011 E2E |
| Standard (well-scoped, pattern-following) | **Claude Sonnet 5** | ISS-001, ISS-002, ISS-008 Mastodon provider, ISS-010 audit/notifications, ISS-012 deploy |

Rules: the implementing model for an issue is fixed in its header. A Sonnet session hitting genuine design ambiguity stops and escalates rather than guessing. Skills to load per issue are listed in issue headers (frontend work loads `frontend-design-pro` + `fd-eng-skill`).

**Model version policy:** assignments bind to the TIER, not the version number. At execution time, use the newest released model in that tier; as of July 2026 the standard tier runs on Sonnet 5 (released June 30, 2026). If a tier upgrade lands mid-issue, finish the in-flight issue on the model that started it, then upgrade for the next issue. Reviews always use the newest frontier model available. **Fallback rule:** if Fable 5 is unavailable in the owner's plan at execution time, Opus 4.8 (or the newest Opus) takes over the hard tier and reviews; hard-tier issues are never delegated below Opus.
