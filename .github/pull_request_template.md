## Issue

Closes ISS-XXX.

## Summary

<!-- What this PR does and why. If a design decision borrows an idea from the reference codebase, note "pattern reference: postiz <file path>". -->

## Verification gates (paste real output or link to CI run)

- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` green, including new tests for this issue
- [ ] `pnpm build` succeeds
- [ ] Feature exercised end to end, output pasted below

## Security checklist (SECURITY.md section 5)

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

Any unchecked item without an owner-approved exception (see SECURITY.md section 6) blocks merge.
