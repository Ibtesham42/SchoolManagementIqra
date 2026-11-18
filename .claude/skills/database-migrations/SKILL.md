---
name: database-migrations
description: Use when changing prisma/schema.prisma, writing or reviewing a migration, adding indexes/constraints, or applying migrations to any Neon branch. Defines the mandatory review-before-execution workflow and Prisma 7 / Neon specifics.
---

# Prisma & PostgreSQL migrations

## Mandatory workflow (no exceptions)
1. Edit `prisma/schema.prisma` (conventions in `.claude/rules/database.md`).
2. `npx prisma format && npx prisma validate`.
3. Generate without applying: `npx prisma migrate dev --create-only --name <snake_case_change>` against the **development** branch only (`env:check` must pass first).
4. **Review the SQL**: destructive statements (DROP/ALTER TYPE/NOT NULL on existing data), locks on large tables, backward compatibility with the running release (expand → backfill → contract), index names, raw-SQL additions commented.
5. **Owner approval** before applying anything.
6. Apply to `development`, then `test` — the test branch via `.env.test` selected with `DOTENV_PATH` **inside `try/finally`**, after the 7.0 check that no `DATABASE_URL`/`DIRECT_URL`/`DOTENV_PATH` is already set (docs/NEON_SETUP_GUIDE.md §7; verified: dotenv 18 honours `DOTENV_PATH`, the Prisma CLI doesn't load `.env` itself, shell variables override files, `$env:` persists in PowerShell). Never put a connection string on the command line. Run integration tests on `test`.
7. Update docs/DATABASE_SCHEMA.md and DATABASE_RELATIONSHIPS.md in the same change.
8. Production: only `prisma migrate deploy` of the committed, reviewed migration, after explicit owner approval and a fresh backup.

Never: `migrate reset`, `db push --force-reset` (denied in settings), editing applied migrations, running anything against production from a dev machine.

## Prisma 7 / Neon specifics
- Client generated to `src/generated/prisma` (git-ignored); import from `@/generated/prisma/client`.
- `prisma.config.ts` reads `DIRECT_URL` (CLI/migrations); runtime uses the pooled `DATABASE_URL` via `@prisma/adapter-pg` (`src/lib/db.ts`, lazy client).
- The CLI does not load `.env` itself — `prisma.config.ts` imports `dotenv/config`. CI uses a non-secret placeholder `DIRECT_URL` for `generate` only.
- Partial indexes/exclusion constraints in raw SQL may be "drifted" away by later diffs — prefer schema-expressible designs (e.g. a unique FK on a singleton instead of a partial unique index).
- Transaction-scoped advisory locks work through Neon's transaction pooler; session-level ones don't.
- Keep storage small (Neon Free budget ~512 MB): files never in the DB; housekeeping via `npm run cleanup`.
