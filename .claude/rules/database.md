---
paths:
  - "prisma/**"
  - "src/**/*.service.ts"
  - "src/lib/db.ts"
  - "src/lib/sequence.ts"
---

# Database rules

- `prisma/schema.prisma` is the source of truth; update docs/DATABASE_SCHEMA.md and DATABASE_RELATIONSHIPS.md in the same change.
- Migrations are **reviewed before execution**: `npx prisma migrate dev --create-only --name <snake_case_change>` → read the generated SQL → owner approval → apply to the Neon `development`/`test` branches only. Production receives only `prisma migrate deploy` of committed, reviewed migrations, after explicit owner approval.
- Migrations: Never edit an applied migration; never run `migrate reset` or `db push --force-reset` (denied in settings). Partial unique indexes, exclusion constraints and `vector` indexes go in migration SQL with a comment.
- Production migrations must be backward compatible with the previous release (expand → backfill → contract).
- Models: `PascalCase`, `@@map("snake_case")`; fields `camelCase`, `@map` to snake_case. IDs `cuid(2)`. Timestamps `createdAt`/`updatedAt` on every table.
- Money `@db.Decimal(12,2)`; school-local dates `@db.Date`; instants `@db.Timestamptz`.
- Session-scoped data must have `academicSessionId`.
- Soft delete via `deletedAt` for students, guardians, employees, invoices, CMS content, books, assets. Default queries exclude soft-deleted rows (Prisma client extension).
- Use `prisma.$transaction(async (tx) => …)` for multi-write workflows; pass `tx` down — never mix `tx` and the global client inside one workflow.
- Sequences only through `nextSequence(tx, key)` in `lib/sequence.ts` (row-locked upsert `… RETURNING`).
- No unbounded `findMany` on large tables; paginate and `select` only needed columns.
- `$queryRawUnsafe` / `$executeRawUnsafe` are forbidden.
