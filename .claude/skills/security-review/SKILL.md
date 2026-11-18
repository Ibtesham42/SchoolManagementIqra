---
name: security-review
description: Use before marking any feature complete, when building any endpoint/server action that handles input or data, and for periodic audits. A checklist for secure API development and review in this project, based on the 2026-11-08 audit findings (SECURITY.md A1–A20).
---

# Security review & secure API development

## Checklist for every endpoint / server action
1. **AuthN/AuthZ:** `requireAuth()`; service calls `authorize(ctx, perm)`; record scope enforced in `*.policy.ts`; IDOR test exists.
2. **Input:** Zod `.strict()` schema; lengths bounded; IDs validated; malformed query params fall back safely.
3. **Output:** explicit Prisma `select` of safe fields only; sensitive fields need `*.sensitive.read`; no internals in errors (`fromError`).
4. **Transactions & concurrency:** multi-write → one transaction; invariants protected by locks (advisory lock for global invariants; `FOR UPDATE` only on the rows you re-check); slow CPU work (Argon2, PDF) outside the transaction.
5. **Audit:** `audit(tx, …)` in the same transaction; secrets redacted (`lib/audit.ts` keys).
6. **Abuse & cost:** public or expensive endpoints rate limited (`lib/rate-limit.ts`); public paths don't hit the DB on every request (Neon compute, FREE_TIER.md).
7. **Secrets:** none in code, logs, docs, tests or URLs; tokens in links go in the fragment; logs contain error names, not messages with data.
8. **Headers/CSP:** pages stay dynamic; no new inline scripts; new origins added to `lib/csp.ts` deliberately.
9. **Files (Phase 2+):** private storage, app-side encryption, magic-byte type checks, size limits, authorized download only.
10. **Lint & architecture:** `npm run lint` (unsafe-SQL ban, layer rules) and `npm run check:deps` pass.

## Review output format
Severity (critical/high/medium/low), file:line, concrete exploit or failure scenario, fix, and the test that proves the fix. No speculative findings without a path. Record findings in docs/SECURITY.md with an ID.

## Lessons from past findings (don't repeat)
- Protecting only Super Admin targets let delegates take over other privileged accounts (A1).
- `SELECT … FOR UPDATE` over a join is not enough under READ COMMITTED (A2).
- A lint rule that silently never matches is worse than none — test rules with probe files (A3).
- Sliding sessions need an invariant idle window and an absolute cap (A4).
- Query-string tokens leak into logs; timing can leak account existence (A5, A6).
