---
paths:
  - "tests/**"
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Testing rules

- Follow docs/TESTING_STRATEGY.md. Unit tests for pure logic, integration tests for services against a real Postgres test database, Playwright for journeys (desktop + Pixel 7 + iPhone 14 projects).
- Never mock Prisma. Mock only external providers via their interfaces.
- RBAC tests are table-driven over all seeded roles.
- Test data is synthetic and built with factories in `tests/factories/`. No real names, phone numbers or Aadhaar-like numbers that pass Verhoeff validation.
- A feature is not complete until its tests pass locally: `npm run lint && npm run typecheck && npm test` (and `npm run test:e2e` at phase end). Report failures honestly with output.
