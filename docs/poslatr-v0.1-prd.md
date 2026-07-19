# PRD: Poslatr v0.1

**Self-hosted social media manager. Personal tool first, market-ready architecture.**

| Field | Value |
|---|---|
| Version | 0.1.0 (Spine + Mastodon) |
| Audience | AI coding agents (Claude Code). Not written for human developers. |
| Product owner | Otee (final approver on all gates) |
| Status | Draft for owner review |
| Repo name | `poslatr` (confirmed) |

---

## 1. Context

Poslatr is a greenfield, self-hosted social media manager. It composes, stores, schedules, and publishes posts across social platforms. Postiz (github.com/gitroomhq/postiz-app) is the open textbook: read its provider implementations and orchestration patterns as reference, never copy code (AGPL-3.0 contamination risk for a future closed-source product).

v0.1 builds the spine and proves it end to end with exactly one platform, Mastodon, chosen because it has no approval gates. Platform breadth comes later (v0.2 Bluesky, v0.3 Instagram Business, v0.4+ LinkedIn, X, Facebook Pages). The architecture must make adding a platform a plugin operation with zero core changes.

### v0.1 goals

1. A scheduled post with an image publishes to Mastodon unattended at the scheduled time.
2. A forced provider failure retries with backoff and surfaces to the user via the failure UX.
3. Adding a second provider later requires no changes outside `packages/providers/`.
4. Every publish action, manual or scheduled, lands in the audit log.

### v0.1 non-goals

- No Instagram, Bluesky, or any second platform.
- No analytics, evergreen recycling, AI captions, approval workflows, MCP server.
- No multi-tenancy. Single owner account, but the schema must not block multi-tenancy later (every table carries `workspace_id`).
- No mobile app.

---

## 2. Stack (fixed, do not substitute)

Per the owner's engineering framework defaults:

- **Language:** TypeScript, strict mode, everywhere.
- **Monorepo:** pnpm workspaces + Turborepo.
- **Web app:** Next.js (App Router) in `apps/web`. UI and API routes.
- **Worker:** standalone Node process in `apps/worker`. Runs BullMQ consumers.
- **DB:** PostgreSQL 16. **ORM:** Drizzle. Migrations via drizzle-kit, forward-only.
- **Queue:** BullMQ on Redis 7.
- **Object storage:** MinIO (S3-compatible) on the VPS. All storage access through the S3 SDK so Backblaze/R2/Drive become config swaps.
- **Validation:** Zod at every boundary (API input, provider output, env vars, queue payloads).
- **Deployment:** Docker Compose services deployed via Coolify on Hetzner VPS.
- **Testing:** Vitest (unit + contract), Playwright (E2E).

If any library above cannot satisfy a requirement, STOP and ask the owner. Do not substitute silently.

---

## 3. Architecture

```
apps/
  web/            Next.js: compose UI, calendar, connections, settings, API routes
  worker/         BullMQ consumers: publish jobs, media renditions, token refresh
packages/
  core/           domain types, canonical post model, zod schemas, errors
  db/             drizzle schema, migrations, repositories
  providers/      provider contract + one folder per platform (v0.1: mastodon)
  media/          storage client, signed URLs, rendition pipeline
  vault/          token encryption/decryption (never exposed outside this package)
  audit/          audit log writer, structured events
```

### 3.1 Canonical post model (packages/core)

- `Post`: id, workspace_id, status (`draft | scheduled | publishing | published | failed | cancelled`), body (rich text as portable JSON), scheduled_at (UTC), timezone, created/updated timestamps.
- `PostTarget`: one row per (post, connected account). Carries per-platform body overrides, remote_post_id, per-target status, error details, attempt count.
- `MediaAsset`: id, workspace_id, storage_key, mime, bytes, width/height/duration, checksum, renditions (JSON map of rendition name to storage_key).
- `Connection`: id, workspace_id, provider_id, display name, encrypted credentials reference (vault), token expiry, health status (`ok | expiring | broken`).

Schema evolution rule: new fields are additive and optional. Never repurpose a column. Never write a down migration.

### 3.2 Provider contract (packages/providers)

Every provider implements:

```
interface Provider {
  id: string;                                  // "mastodon"
  capabilities(): CapabilitySchema;            // declarative, zod-validated
  auth: {
    beginConnect(ctx): Promise<ConnectStart>;  // OAuth URL or credential form spec
    completeConnect(ctx, payload): Promise<Credentials>;
    refresh(credentials): Promise<Credentials>;
  };
  validate(post: CanonicalPost): ValidationResult;      // pure, no network
  prepareMedia(assets: MediaAsset[]): RenditionRequest[];
  publish(post: PreparedPost, creds): Promise<PublishResult>;
  status(remoteId: string, creds): Promise<RemoteStatus>;
}
```

`CapabilitySchema` declares: supported content types (text/image/video/carousel), max chars, max media count, allowed mime types, media constraints (aspect ratios, max bytes, max duration), rate windows. The compose UI renders limits and the validator enforces them FROM THIS DECLARATION. Hardcoding a platform limit anywhere outside a provider's capability schema is a review-blocking defect.

Registration: providers self-register in a registry keyed by `id`, gated by a per-provider feature flag (env-driven in v0.1). Core code must never reference a provider id in a conditional. Grep check `grep -rn "mastodon" apps/ packages/core packages/db` must return zero matches outside `packages/providers/mastodon` and seed/config files.

### 3.3 Scheduling and publishing flow

1. User schedules post → row written with status `scheduled`, BullMQ delayed job enqueued with `jobId = postTarget.id` (idempotency key).
2. At fire time, worker transitions target to `publishing` via conditional UPDATE (`WHERE status = 'scheduled'`). Zero rows updated means another worker won the race: exit cleanly.
3. Worker resolves renditions from media module, requests short-TTL signed URLs, decrypts credentials via vault, calls `provider.publish()`.
4. Success: store `remote_post_id`, status `published`, audit event.
5. Failure: classify error (retryable vs terminal via provider error mapping), retry with exponential backoff + jitter (max 5 attempts), then status `failed`, dead-letter record, user-facing notification, audit event.
6. Per-provider queues (`publish:mastodon`). A broken provider only poisons its own queue.

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

---

## 8. Issues

Execution order = numeric order. Each issue below is written to be pasted directly into GitHub.

---

### ISS-001: Repository bootstrap and CI

**Model:** Sonnet 5 · **Depends on:** none · **Labels:** infra

**Goal:** Private GitHub repo with protections, labels, milestones, and CI that enforces the verification gates.

**Todos**
- [ ] `gh repo create poslatr --private`
- [ ] Default branch `main`, branch protection: PR required, CI required, no force push
- [ ] Labels: `security`, `provider`, `core`, `infra`, `ui`, `blocked`, `needs-owner`
- [ ] Milestones: `v0.1 Spine`, `v0.2 Bluesky`, `v0.3 Instagram`
- [ ] Create all ISS-002 through ISS-012 as GitHub issues from this PRD, assigned to milestones
- [ ] Commit `SECURITY.md` (the consolidated policy file delivered with this PRD), `CONTRIBUTING.md` (sections 4 to 7 of this PRD verbatim), PR template embedding the checklist from SECURITY.md section 5
- [ ] GitHub Actions: typecheck, lint, test, build, `pnpm audit --audit-level=high` on every PR

**Expected outcome:** Empty-but-governed repo; a trivial PR demonstrably blocked until CI passes.

**Test cases**
1. Push directly to `main` → rejected.
2. Open PR with failing lint → merge blocked.
3. `gh issue list` shows ISS-002..012 with correct milestones and labels.

---

### ISS-002: Monorepo scaffold

**Model:** Sonnet 5 · **Depends on:** ISS-001 · **Labels:** infra

**Goal:** pnpm + Turborepo workspace with `apps/web`, `apps/worker`, and all `packages/*` stubs compiling, plus Docker Compose for Postgres, Redis, MinIO.

**Todos**
- [ ] Workspace layout per section 3, strict tsconfig shared via `packages/config`
- [ ] ESLint + Prettier, no-floating-promises and no-explicit-any enforced
- [ ] `docker-compose.dev.yml`: postgres:16, redis:7, minio + bucket bootstrap
- [ ] Zod-validated env loader in `packages/core` (fails fast on missing vars)
- [ ] `pnpm dev` boots web + worker against compose services

**Expected outcome:** All four verification gates pass on the empty skeleton.

**Test cases**
1. Fresh clone → `pnpm i && docker compose -f docker-compose.dev.yml up -d && pnpm dev` works with only `.env.example` copied.
2. Deleting a required env var causes boot refusal with a named error.

---

### ISS-003: Database schema and repositories

**Model:** Opus 4.8 · **Depends on:** ISS-002 · **Labels:** core

**Goal:** Drizzle schema for Workspace, User, Connection, Post, PostTarget, MediaAsset, AuditEvent, DeadLetter, exactly per section 3.1, with repository functions and seeds.

**Todos**
- [ ] Schema + first migration (forward-only), all tables prefixed `psl_` per SECURITY.md 2.21, `workspace_id` on every domain table, FK integrity, indexes on (`status`, `scheduled_at`) and (`workspace_id`, `created_at`)
- [ ] Status enums as Postgres enums; transitions enforced in repository layer via conditional updates
- [ ] Repositories in `packages/db` only; apps never import drizzle client directly
- [ ] Seed script: one workspace, one user
- [ ] Unit tests for every legal and illegal status transition

**Expected outcome:** `pnpm db:migrate && pnpm db:seed` produces a queryable dev DB; illegal transitions throw typed errors.

**Test cases**
1. `scheduled → publishing` conditional update returns 1 row once, 0 rows on the racing second call.
2. `published → scheduled` rejected.
3. Migration runs idempotently on an already-migrated DB.

**Security checklist focus:** parameterized queries only; no raw SQL.

---

### ISS-004: Token vault

**Model:** Fable 5 · **Depends on:** ISS-003 · **Labels:** security, core

**Goal:** `packages/vault`: authenticated encryption for provider credentials with the narrowest possible API surface.

**Todos**
- [ ] libsodium sealed-box (or secretbox with per-record nonce) encrypt/decrypt; master key from env, zod-validated for length/entropy
- [ ] Public API exactly `encryptCredentials`, `decryptCredentials`, `rotateMasterKey`; internals unexported
- [ ] Ciphertext stored with key-version tag to enable rotation
- [ ] `rotateMasterKey` re-encrypts all rows in a transaction, resumable on failure
- [ ] Lint rule or unit test asserting no import of `packages/vault` from `apps/web` client components
- [ ] Redaction: credential objects have a `toJSON` that throws, preventing accidental logging

**Expected outcome:** Round-trip works; ciphertext in DB is opaque; rotation migrates all records and old key then fails decryption.

**Test cases**
1. Encrypt → decrypt round-trip equality.
2. Tampered ciphertext → authentication failure, typed error, no partial output.
3. Rotation: 100 seeded credentials re-encrypted; interrupt mid-rotation and resume completes without loss.
4. `JSON.stringify(credentials)` throws.

**Review note:** Fable 5 cold review must specifically attack nonce reuse, key handling in memory, and error-path leakage.

---

### ISS-005: Provider contract, capability schema, registry, contract test harness

**Model:** Fable 5 · **Depends on:** ISS-003 · **Labels:** core, provider

**Goal:** The plugin seam. Everything in section 3.2, plus a reusable contract test suite every future provider must pass.

**Todos**
- [ ] `Provider` interface + zod `CapabilitySchema` in `packages/core`
- [ ] Registry with feature-flag gating; unknown/disabled provider = typed error
- [ ] Error taxonomy: `RetryableProviderError`, `TerminalProviderError`, `AuthExpiredError` with mapping guidance
- [ ] Contract test harness: given any provider, asserts capability schema validity, validate() purity (no network, property-based inputs), publish() error mapping via injected fake transport
- [ ] `FakeProvider` implementation used by scheduler tests
- [ ] The provider-agnosticism grep check from 3.2 wired into CI

**Expected outcome:** FakeProvider passes the harness; core compiles with zero references to any concrete provider.

**Test cases**
1. Registering a provider with an invalid capability schema fails at boot.
2. Disabled feature flag → provider invisible to UI and scheduler.
3. Harness fails a deliberately broken provider (e.g., validate() doing network I/O via injected spy).

---

### ISS-006: Media module

**Model:** Opus 4.8 · **Depends on:** ISS-003 · **Labels:** core

**Goal:** Upload to MinIO, checksum dedupe, rendition pipeline, short-TTL signed URLs, SSRF-guarded fetching.

**Todos**
- [ ] Direct-to-MinIO uploads via presigned PUT from the API (size + mime allowlist enforced before presigning)
- [ ] SHA-256 checksum; identical asset re-upload returns existing record
- [ ] Rendition worker job: sharp for images (resize/crop per RenditionRequest), ffmpeg behind an interface for video (v0.1 images only, interface ready)
- [ ] Signed GET URLs, 15-min TTL, private bucket verified at boot
- [ ] SSRF guard utility (deny private ranges/localhost/link-local) exported from `packages/media` for all future server-side fetches

**Expected outcome:** Upload from UI → asset row + object in MinIO; rendition request produces derived object; unsigned object URL returns 403.

**Test cases**
1. Presign rejects disallowed mime and oversize declarations.
2. Duplicate upload (same checksum) creates no new object.
3. Signed URL works before TTL, 403 after.
4. SSRF guard blocks `http://169.254.169.254/` and `http://localhost:9000/`.

---

### ISS-007: Scheduler and publish worker

**Model:** Fable 5 · **Depends on:** ISS-004, ISS-005, ISS-006 · **Labels:** core, security

**Goal:** BullMQ scheduling exactly per section 3.3: idempotent, race-safe, per-provider queues, backoff, DLQ, and cancellation.

**Todos**
- [ ] Enqueue on schedule with `jobId = postTarget.id`; reschedule = remove + re-add atomically
- [ ] Conditional-update claim (`scheduled → publishing`) before any network call
- [ ] Retry: exponential backoff + jitter, max 5, only for `RetryableProviderError`; `AuthExpiredError` marks connection `broken` and terminal-fails with a distinct user message
- [ ] DLQ table row + notification event on terminal failure
- [ ] Cancellation: user cancels a scheduled post → job removed, status `cancelled`; cancelling mid-`publishing` is rejected with a clear message
- [ ] Graceful shutdown: SIGTERM drains in-flight jobs before exit
- [ ] Clock discipline: all comparisons in UTC; scheduled_at stored UTC with original timezone alongside

**Expected outcome:** With FakeProvider, a post scheduled 30s out publishes exactly once with two workers running; forced retryable failure retries per policy; forced terminal failure dead-letters and notifies.

**Test cases**
1. Two workers, one job → exactly one publish (assert via FakeProvider call count).
2. Worker killed mid-job after claim → job recovers on restart without double-publish (idempotency via remote-side check or claim state).
3. Retryable error ×5 → DLQ row, status `failed`, notification written.
4. Cancel before fire time → job absent from queue, status `cancelled`, audit event.
5. DST boundary: post scheduled in Europe/Berlin across a DST shift fires at correct wall-clock time.

**Review note:** Fable 5 cold review must attack the claim race, at-least-once vs exactly-once semantics, and shutdown behavior.

---

### ISS-008: Mastodon provider

**Model:** Sonnet 5 · **Depends on:** ISS-005, ISS-007 · **Labels:** provider

**Goal:** First real provider, implemented purely against the contract.

**Todos**
- [ ] Auth: instance-URL input → OAuth app registration flow → token stored via vault
- [ ] Capability schema: 500 chars default (read instance config for actual limit), 4 images, mime and size limits per instance API
- [ ] `publish`: upload media to Mastodon, poll processing, create status, return remote id + URL
- [ ] Error mapping: 429 and 5xx retryable, 401 auth-expired, 422 terminal
- [ ] Passes the ISS-005 contract harness; integration test against a mocked Mastodon API (recorded fixtures)

**Expected outcome:** Owner connects a real Mastodon account through the UI and a scheduled image post appears on the timeline unattended.

**Test cases**
1. Contract harness green.
2. Instance with a custom char limit (e.g. 5000) reflects in capability output.
3. 429 response → job retried; 422 → terminal with user-readable reason.

---

### ISS-009: Compose UI, calendar, connections UI

**Model:** Opus 4.8 (load `frontend-design-pro` + `fd-eng-skill`) · **Depends on:** ISS-006, ISS-005 · **Labels:** ui

**Goal:** The owner-facing surface: connect accounts, compose with live capability-driven validation, schedule, see calendar and failures.

**Todos**
- [ ] Auth screens (login only, seeded user), session per section 5.1 item 5
- [ ] Connections page: add Mastodon connection, health badge (`ok/expiring/broken`), reconnect flow
- [ ] Composer: text + media upload, per-target validation rendered from `capabilities()` (char counter, media limits), schedule picker with timezone display, "post now" path
- [ ] Calendar (week view) with scheduled/published/failed states; failed posts expose reason + retry action
- [ ] Design tokens derived from a concrete reference, never generic defaults (owner rule). Primary reference: the Cal.com design system (open source, github.com/calcom/cal.com; study their tokens, typography, spacing, and component styling and derive Poslatr's tokens from that language). If the owner supplies his LiD design system tokens before this issue starts, LiD takes precedence over Cal.com. Extract and adapt from the chosen reference; inventing tokens or falling back to framework defaults is a review-blocking defect.

**Expected outcome:** Full loop through the UI: connect, compose, schedule, observe publish, observe a forced failure with its reason.

**Test cases (Playwright)**
1. Char counter and media limits change when capability schema changes (test with FakeProvider variants).
2. Unauthenticated access to any app route redirects to login.
3. Failed post shows mapped user-readable error, not a stack trace.

---

### ISS-010: Audit log and notifications

**Model:** Sonnet 5 · **Depends on:** ISS-007 · **Labels:** core

**Goal:** Append-only audit trail and user-facing failure notifications.

**Todos**
- [ ] `packages/audit`: `writeEvent(actor, action, entity, outcome, meta)` with zod-validated event types; called from every state-changing path (verify by checklist against ISS-003..008 code)
- [ ] Audit viewer page (filter by entity/action/date)
- [ ] Notification on terminal publish failure: in-app notification center + email via SMTP (owner's existing Sendly infrastructure; confirm SMTP details with owner, stop condition)
- [ ] Correlation ID flows from API request → job → provider call → audit event → log lines

**Expected outcome:** Every action from the ISS-009 E2E loop is visible in the audit viewer with correlation IDs; a dead-lettered post produces an email.

**Test cases**
1. Attempted UPDATE/DELETE on audit table fails (DB grant or trigger).
2. Publish failure → notification row + email captured by test SMTP (mailpit in compose).
3. Correlation ID identical across API log, worker log, audit event for one action.

---

### ISS-011: End-to-end acceptance suite

**Model:** Opus 4.8 · **Depends on:** ISS-008, ISS-009, ISS-010 · **Labels:** core

**Goal:** Automated proof of the four v0.1 goals, runnable in CI against compose services + mocked Mastodon.

**Todos**
- [ ] Scenario A: schedule with image 60s out → published, remote id stored, audit trail complete
- [ ] Scenario B: forced retryable failures → retries → success; forced terminal → DLQ + notification + UI surfacing
- [ ] Scenario C: worker restart mid-schedule window → no loss, no duplicate
- [ ] Scenario D: provider-agnosticism grep + FakeProvider registered as second provider with zero core diffs (assert via git)
- [ ] Wire the suite as the required CI gate for the v0.1 release tag

**Expected outcome:** One command (`pnpm e2e`) proves v0.1's definition of done.

---

### ISS-012: Production deployment

**Model:** Sonnet 5 · **Depends on:** ISS-011 · **Labels:** infra

**Goal:** Poslatr live on the Hetzner VPS via Coolify, isolated from the owner's other running services.

**Todos**
- [ ] Production compose/Coolify config: web, worker, postgres, redis, minio, mailpit removed, real SMTP env
- [ ] HTTPS via Coolify/Traefik, headers per 5.1 item 11, MinIO not publicly exposed except the signed-URL endpoint path
- [ ] Distinct Docker network and resource limits so Poslatr cannot starve Sendly or other services (confirm host capacity with owner, stop condition)
- [ ] Backups: nightly pg_dump + MinIO bucket sync to a second location, restore procedure documented and rehearsed once
- [ ] Uptime + queue-depth monitoring (healthcheck endpoint + simple alerting to email)

**Expected outcome:** Owner schedules a real Mastodon post from a phone browser; it publishes; a restored backup on a scratch DB boots the app.

**Test cases**
1. `docker compose down && up` on the host → scheduled jobs survive (Redis persistence + DB reconciliation on worker boot).
2. Restore drill from last night's backup succeeds.
3. SSL Labs grade A on the deployed domain.

---

## 9. Definition of done, v0.1

- ISS-001 through ISS-012 merged, each with a Fable 5 cold review scoring ≥ 4 on all dimensions or owner-approved exceptions on file.
- The four v0.1 goals demonstrated by the ISS-011 suite in CI and once manually in production.
- `SECURITY.md`, `CONTRIBUTING.md`, and this PRD live in the repo; PR template enforces the security checklist.
- Zero open `security`-labeled issues.

## 10. Open items for the owner

1. ~~Final repo/product name before ISS-001 runs.~~ Resolved: Poslatr, repo `poslatr`.
2. ~~Supply the full Security Policy Framework document for `SECURITY.md`.~~ Resolved: SECURITY.md delivered with this PRD.
3. ~~Design reference for ISS-009 tokens.~~ Resolved: Cal.com design system as primary reference, superseded by the owner's LiD design system tokens if supplied before ISS-009 starts.
4. SMTP details (Sendly) for ISS-010 and host capacity confirmation for ISS-012.
