---
name: testing-and-quality
description: Use when writing or running tests, verifying a feature before marking it complete, closing a project phase, or setting up test infrastructure (Vitest, Playwright, test database, factories).
---

# Testing & quality

## Before saying "done"
1. `npm run typecheck && npm run lint && npm run check:deps && npm run test:unit` — all green (this is also what CI runs).
2. Database-backed code: `npm test` with `TEST_DATABASE_URL` pointing at the Neon **test** branch (never development/production). Without it, integration tests are **skipped — report them as pending**, never as passed.
3. Journeys touched: `npm run test:e2e` against a production build (desktop, Pixel 7, iPhone 14; add tablet for layout work). Offline mode (no DB) runs the auth-pages + degraded specs; DB specs skip as pending.
4. Exercise the feature at phone, tablet and desktop sizes (ui-accessibility skill).
5. Update DEVELOPMENT_PROGRESS.md and CHANGELOG.md with passed / failed / skipped (pending) / not-run counts and where they ran.

## Patterns
- **Unit**: pure functions (`*-calc.ts`, `roll-number.ts`, formatters, parsers). Table-driven.
- **Integration**: call service functions with a real `AuthContext` obtained from a real session (`createSession` → `validateSessionToken`, see `tests/integration/identity-admin.test.ts`), against the Neon `test` branch. Prefix test data with a per-run id and clean it up in `afterAll`. (A shared `tests/helpers` factory does not exist yet — extract one when a second module needs it.)
- **RBAC matrix**:
  ```ts
  describe.each(ALL_ROLES)("%s → student.sensitive.read", (role) => {
    it(ALLOWED.has(role) ? "allows" : "denies", async () => { … });
  });
  ```
- **Concurrency**: `Promise.all` of N service calls, then assert uniqueness and count.
- **E2E**: Playwright with seeded users per role; use `getByRole`/labels (also validates accessibility); run axe on each page.
- **External providers**: inject fake implementations of the interface (payment, AI, email); never call real services in tests.

## Phase gate checklist
- [ ] Every feature in the phase has unit/integration coverage of its rules
- [ ] RBAC tests for every new endpoint
- [ ] E2E for primary journeys on mobile + desktop
- [ ] No serious axe violations
- [ ] Docs updated; KNOWN_ISSUES has anything deferred
