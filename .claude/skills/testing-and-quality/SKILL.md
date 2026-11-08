---
name: testing-and-quality
description: Use when writing or running tests, verifying a feature before marking it complete, closing a project phase, or setting up test infrastructure (Vitest, Playwright, test database, factories).
---

# Testing & quality

## Before saying "done"
1. `npm run lint && npm run typecheck && npm test` — all green.
2. For journeys touched: `npm run test:e2e` (desktop + Pixel 7 + iPhone 14).
3. Manually exercise the feature end-to-end at 360px and desktop.
4. Update DEVELOPMENT_PROGRESS.md and CHANGELOG.md. If something failed or was skipped, say so with the output.

## Patterns
- **Unit**: pure functions (`*-calc.ts`, `roll-number.ts`, formatters, parsers). Table-driven.
- **Integration**: call service functions with a real `AuthContext` built by `tests/helpers/auth.ts` (`asRole("TEACHER", { assignedSections })`), against the test DB. Reset with truncation between files.
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
