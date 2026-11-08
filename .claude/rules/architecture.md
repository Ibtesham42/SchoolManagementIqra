# Architecture rules

- Modular monolith. Domain code lives in `src/modules/<domain>/`; cross-cutting code in `src/lib/`. See docs/SYSTEM_ARCHITECTURE.md §3 for the module map and allowed dependencies.
- A module may call another module's **service**, never its Prisma models directly.
- `src/chatbot/**` must not import from `src/modules/**` (enforced by ESLint `no-restricted-imports`). The chatbot reads only knowledge/FAQ/config tables.
- Request flow: route handler or server action → Zod parse → service (authorize → policy → transaction → audit) → response. Keep route handlers and actions under ~30 lines.
- External providers (payments, AI, storage, email, SMS, rate limiter) are behind interfaces in `src/lib/<area>/` with a `none`/local implementation for development and tests.
- New architectural decisions get an ADR row in docs/SYSTEM_ARCHITECTURE.md §2 in the same change.
