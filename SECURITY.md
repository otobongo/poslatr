# Poslatr Security Policy (SECURITY.md)

**Source:** Consolidated from the owner's Security Audit Instructions, Security Scan Prompt, and security-test skill. Tailored to the Poslatr stack: Next.js (App Router), Drizzle + PostgreSQL 16, BullMQ + Redis, MinIO (S3 API), Coolify on Hetzner. Sections for Supabase, Firebase, Vue, Angular, PHP, and Python from the source documents are intentionally omitted as not applicable.

**Enforcement:** This policy is binding on every issue and every PR. It is referenced by the PRD (sections 4 to 6), embedded in the PR template as a checklist, and verified item by item during the cold principal-engineer review. Unchecked items without an approved exception block merge.

---

## 1. Severity levels and remediation timelines

| Level | Meaning | Action |
|---|---|---|
| CRITICAL | Immediate exploitation risk. Data breach likely. | Must fix before merge, no exceptions |
| HIGH | Significant risk. Could lead to unauthorized access. | Fix within the current issue |
| MEDIUM | Moderate risk. Exploitable under certain conditions. | Fix before the release tag |
| LOW | Best practice violations. | Fix when convenient, tracked as an issue |

---

## 2. Vulnerability categories

### 2.1 Secrets and credentials (CRITICAL)
- No hardcoded API keys, passwords, or tokens anywhere, including test fixtures
- No secrets in client bundles; only `NEXT_PUBLIC_` variables reach the client, and no secret is ever named `NEXT_PUBLIC_`
- `.env` gitignored; `.env.example` maintained; no secrets in version control history
- Env vars validated by zod at boot; missing or malformed secret means the process refuses to start
- No sensitive data in URLs or query strings (tokens, keys); reset and verification links use POST-consumed, single-use tokens where feasible
- Poslatr-specific: the vault master key is env-only, length and entropy validated; platform OAuth tokens exist in plaintext only inside `packages/vault` call scope

### 2.2 Injection (CRITICAL)
- SQL: Drizzle parameterized queries only; no string concatenation; raw SQL requires owner approval (PRD stop condition)
- Command: no `exec()`, `spawn()`, `system()` with user input anywhere; ffmpeg/sharp invocations in the media worker take validated, server-generated arguments only, never user-supplied strings
- Template: no user input in server-side template strings; React escaping never bypassed
- `JSON.parse()` on external input always wrapped in try/catch and followed by zod validation (applies to API bodies, queue payloads, and provider API responses)

### 2.3 Input validation (CRITICAL)
- Server-side zod validation on every API route, server action, queue payload, and provider response; reject, never sanitize-and-continue
- Numeric bounds: no negative or zero values where nonsensical (media byte sizes, retry counts, schedule offsets)
- String length limits on all free-text fields (post body capped against the target platform's declared capability limit plus a hard global ceiling)
- Date/time: `scheduled_at` must be in the future at schedule time; stored UTC; timezone string validated against the IANA list
- State transitions: only legal post/target status transitions allowed, enforced in the repository layer via conditional updates (`draft → scheduled → publishing → published | failed`, plus `scheduled → cancelled`); no skipping, no reversing
- Calculations and derived values are computed server-side; client-supplied totals or statuses are never trusted

### 2.4 Authentication (CRITICAL)
- Argon2id password hashing (bcrypt cost 12+ acceptable fallback); never MD5/SHA1; no plaintext ever, including logs and error messages
- Password strength: minimum 12 characters, checked against common-password lists (zxcvbn score 3+), rejected if containing the email local part
- Account lockout after 5 to 10 failed attempts with backoff; login, signup, and reset endpoints rate limited
- No user enumeration: identical responses and timing for valid and invalid identifiers
- Password reset and verification tokens: cryptographically random, single-use, time-limited (24 to 48 hours)
- v0.1 note: Poslatr is single-user with a seeded account; signup, email verification, CAPTCHA, and honeypot controls are not applicable until registration exists, at which point this section applies in full before that feature merges

### 2.5 Session, tokens, and cookies (CRITICAL for tokens, MEDIUM for cookie hygiene)
- Sessions: cryptographically random IDs, idle and absolute timeouts, invalidation on logout, regeneration on any auth state change
- Cookies: `Secure`, `HttpOnly`, `SameSite=Lax` minimum (Strict where flows allow); no sensitive data stored in cookies beyond the session reference
- Session or JWT material never in localStorage
- If JWTs are ever introduced: 256-bit env secret, algorithm pinned explicitly (no `alg: none`), short-lived access tokens (15 min to 1 hour), refresh tokens rotated on use and revocable, `iss` and `aud` verified, no sensitive data in the payload

### 2.6 Authorization and access control (CRITICAL)
- Server-side authorization on every endpoint and server action; the only unauthenticated route is the health check
- User identity always from the session, never from request body or params
- Ownership validation before action: every resource lookup scoped by `workspace_id` derived from the session; no IDOR
- Indirect paths covered: media presign and signed-URL endpoints, audit viewer, exports, search, aggregates, and batch operations all enforce the same workspace scoping
- Admin or elevated functions (when they exist) protected at the route level, not the UI level
- BOLA: object IDs are UUIDs, never sequential integers

### 2.7 Mass assignment and data exposure (CRITICAL)
- Never pass a request body directly to the database; zod schemas whitelist writable fields per operation
- Server-controlled fields (status, workspace_id, remote_post_id, attempt counts, timestamps) are never client-settable
- API responses return only necessary fields; credentials, vault ciphertext, internal error detail, and other users' data never serialize outward
- Credential objects implement a throwing `toJSON` to prevent accidental logging or serialization

### 2.8 CSRF (HIGH)
- CSRF protection on all state-changing requests (POST, PUT, PATCH, DELETE), via framework token or double-submit pattern
- `SameSite` cookies as above; Origin header validated on mutations

### 2.9 SSRF (CRITICAL)
Poslatr fetches external URLs by design (provider APIs, and later RSS or link previews), so this is a first-class concern:
- Single shared guard utility in `packages/media`, used by every server-side fetch
- Protocol allowlist: http and https only; ports 80 and 443 only
- Blocked: localhost, 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, cloud metadata endpoints (169.254.169.254, metadata.google.internal)
- Redirects disabled or re-validated at every hop; DNS resolution checked against the blocklist (rebinding protection)
- Signed URL generation never accepts caller-supplied hosts

### 2.10 XSS and output encoding (HIGH)
- No `dangerouslySetInnerHTML` without DOMPurify; default is to never use it at all
- User content (post bodies, connection names, error strings from providers) rendered as text, never as HTML
- CSP header restricting script sources (see 2.14)

### 2.11 Path traversal and file handling (HIGH)
- Storage keys are server-generated (UUID-based), never derived from user-supplied filenames
- Original filenames stored as display metadata only, sanitized, never used in paths
- Any filesystem path handling validated with `path.resolve()` against an allowed root; no `../` sequences honored
- Upload validation by content (magic bytes), not extension; size limits enforced before presigning; MinIO bucket private with no execution semantics; unique generated object keys

### 2.12 Open redirect (MEDIUM)
- OAuth callback and any post-login redirects validated against an allowlist or restricted to relative paths
- Provider OAuth `redirect_uri` values are fixed configuration, never request-derived

### 2.13 CORS (HIGH)
- No wildcard origin; explicit origin allowlist (the app's own domain)
- Never `Access-Control-Allow-Credentials` with a wildcard origin
- The API is same-origin by design in v0.1; any future public API gets its own reviewed CORS policy

### 2.14 Security headers and transport (MEDIUM headers, HIGH transport)
- HTTPS enforced with 301 redirects; TLS 1.2+; HSTS minimum one year with includeSubDomains; no mixed content
- Content-Security-Policy, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy disabling unused features
- Set via Next.js `headers()` config and verified at the Traefik/Coolify layer

### 2.15 Rate limiting (HIGH)
- Redis-backed limits on auth endpoints (strictest), all API routes, and expensive operations (media presign, manual publish, audit export)
- Rate limit headers returned; limits documented per route
- Outbound: provider calls respect the rate windows declared in each provider's capability schema

### 2.16 Error handling (MEDIUM)
- Generic messages to the client; detailed errors server-side only, with correlation IDs
- No stack traces, connection strings, or provider tokens in any response or client-visible log
- Consistent error response shape across the API

### 2.17 Dependencies (HIGH)
- pnpm lockfile committed; `pnpm audit --audit-level=high` in CI blocks merge on findings
- New dependencies require justification in the PR (PRD stop condition)
- Outdated critical dependencies flagged during quarterly review

### 2.18 Logging and monitoring (MEDIUM)
- Security events logged: login, logout, failed auth, permission denied, connection created or revoked, credential refresh, publish, cancel
- No passwords, tokens, or vault plaintext in logs; user input sanitized before logging (log injection prevention)
- ISO 8601 timestamps; correlation ID flows API → queue → provider call → audit event
- Audit table is append-only, enforced at the database grant or trigger level

### 2.19 Data encryption (HIGH)
- Platform credentials encrypted at rest via `packages/vault` (libsodium authenticated encryption, per-record nonce, key-version tags, rotation support)
- Database connections over SSL in production
- MinIO access over the internal Docker network only; public access exclusively through short-TTL signed URLs (15 minutes)

### 2.20 Deserialization (HIGH)
- No `eval()` or `new Function()` on any external data
- All parsed JSON (requests, queue payloads, provider responses, webhooks) validated with zod immediately after parsing

### 2.21 Database security and table naming (CRITICAL security, HIGH naming)
- Every query scoped to the authenticated workspace; no unfiltered wildcard queries on sensitive tables
- Connection string never exposed client-side
- Table naming convention: all tables prefixed `psl_` (`psl_posts`, `psl_connections`, `psl_media_assets`). Rationale from the source policy: unguessable and collision-safe table names. Fixed project prefix chosen over a random prefix for readability; set once in the Drizzle schema in ISS-003 and never changed after first migration
- Multi-tenant isolation: `workspace_id` on every domain table from day one, even while single-tenant

### 2.22 Poslatr-specific controls
- Vault API surface is exactly `encryptCredentials`, `decryptCredentials`, `rotateMasterKey`; a lint rule or test asserts no vault import from client code
- Queue jobs are idempotent (`jobId` = target ID); consumers claim work via conditional status update before any network call; retries never double-publish
- Provider adapters never log raw credentials or full provider responses at info level
- The future MCP server authenticates with a scoped API key, never holds platform tokens, and writes to the same audit log as UI actions

---

## 3. Prohibited patterns (always CRITICAL, flag on sight)

```javascript
// Hardcoded secrets
const API_KEY = "sk-1234...";

// SQL string concatenation
`SELECT * FROM psl_users WHERE id = '${userId}'`

// eval / dynamic code on user input
eval(userInput); new Function(userInput)();

// Command injection
exec(`ffmpeg -i ${userInput}`);

// Unsanitized HTML
dangerouslySetInnerHTML={{__html: userContent}}

// Client-side-only auth
if (localStorage.getItem('isAdmin')) { showAdmin(); }

// Tokens in localStorage or query strings
localStorage.setItem('token', jwt);
`/reset?token=${token}`

// Identity from the request body
const userId = req.body.userId;

// Mass assignment
db.insert(users).values(req.body);

// Wildcard CORS with credentials
cors({ origin: '*', credentials: true })

// Weak password hashing
crypto.createHash('md5').update(password);

// Path traversal
path.join(uploadDir, userProvidedName);

// Open redirect
redirect(req.query.returnUrl);
```

---

## 4. Scan protocol

Three scan tiers, all run by the implementing agent in Claude Code:

**Per-issue scan (before every PR).** Scope: files touched by the issue plus any new endpoints, tables, or fetch features. Focus: ownership validation, input validation including business logic bounds and state transitions, secrets exposure, SSRF where fetching is present, rate limiting on new endpoints. Findings fixed before the PR opens.

**Full scan (before every release tag and after any auth, vault, or provider change).** Scope: entire codebase against every category in section 2. Output: `SECURITY_SCAN_REPORT.md` in the repo root with the summary table (severity, found, fixed, manual review), issues grouped by severity and category, fixes applied, and manual-review items. Inline markers at each finding: `// TODO [SECURITY]: SEVERITY - description. FIXED.` Console output with severity totals.

**Cold review verification (every PR).** The principal-engineer review independently verifies the per-PR checklist below and spot-checks the scan's claims rather than trusting them.

### Fix behavior

| Situation | Action |
|---|---|
| Clear, unambiguous fix | Fix automatically, report it |
| Table rename or migration | Stop condition: owner approval, all references searched first |
| Business logic ambiguity | Flag for manual review, do not guess |
| Possible breaking change | Ask before applying |

---

## 5. Per-PR security checklist (embedded in the PR template)

```
- [ ] No secrets in diff, logs, or client code
- [ ] All new inputs zod-validated, including business logic bounds and state transitions
- [ ] All new routes/actions assert session + workspace ownership; identity never from request body
- [ ] No raw SQL, no string-built queries, no mass assignment
- [ ] No new public storage access; signed URLs only; filenames server-generated
- [ ] External fetches use the shared SSRF guard
- [ ] State changes write audit events with correlation IDs
- [ ] New deps justified; pnpm audit clean
- [ ] Errors: generic client-side, detailed server-side
- [ ] Per-issue security scan run; findings fixed or excepted
```

---

## 6. Exception process

A control that cannot be implemented requires a written exception before merge:

```
Exception Request: [Issue / Feature]
Category: [Section 2 category]
Control: [The specific control]
Reason: [Why it cannot be implemented now]
Risk: [What this specifically exposes]
Compensating Controls: [What mitigates it in the meantime]
Approval: Owner _____
Remediation Deadline: [Date]
```

Exceptions live in `/security/exceptions/` in the repo and are reviewed at every release tag. CRITICAL categories are not exceptable.

---

## 7. Review cadence

- Per PR: checklist plus cold review, always
- Per release tag: full scan, exception review, `SECURITY_SCAN_REPORT.md` refreshed
- Quarterly: dependency currency review, category updates against current OWASP guidance, policy update with a dated changelog entry

| Date | Version | Change |
|---|---|---|
| Jul 2026 | 1.0 | Initial policy consolidated from owner's audit instructions, scan prompt, and security-test skill; tailored to the Poslatr stack |
