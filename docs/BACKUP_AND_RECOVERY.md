# Backup and Recovery

| Asset | Method | Frequency | Retention |
|---|---|---|---|
| Postgres | Managed provider PITR | continuous | ≥ 7 days PITR |
| Postgres | Logical `pg_dump -Fc` to separate bucket/account, encrypted | daily | 30 daily, 12 monthly, end-of-session (academic year) permanent |
| Files bucket | Versioning + lifecycle on bucket; cross-region/account replication | continuous | 90 days of versions |
| Config | Settings exported as JSON (no secrets) from Super Admin panel | on change | — |

Targets: **RPO ≤ 24 h** (≤ minutes with PITR), **RTO ≤ 4 h**.

## Neon Free specifics (2026-11-08)

- **Point-in-time restore:** Neon Free keeps **6 hours** of history (up to 1 GB of changes). Restore by creating a branch from a past timestamp (Branches → New branch → "from a point in time"), verify it, then repoint `DATABASE_URL`/`DIRECT_URL` or use Neon's branch restore. 6 hours is **not** a backup strategy on its own — daily logical backups are required.
- **Daily logical backup:** `pg_dump -Fc --no-owner "$DIRECT_URL" > school-YYYYMMDD.dump` using PostgreSQL client tools **at least as new as the server** (official free binaries from postgresql.org / EnterpriseDB). Store dumps encrypted (e.g. 7-Zip AES-256 with a passphrase kept offline) on storage the school controls; never in a public bucket.
- **Application-level drill:** `npx tsx scripts/backup-drill.ts <SOURCE_URL> <TARGET_URL>` exports every table, restores into an empty migrated database, resets identity sequences and verifies per-table row counts and content checksums. Use it to rehearse restores into a disposable Neon branch.

## Restore drill (each term)

1. Create a fresh database; `pg_restore` latest dump.
2. Point a staging deployment at it with storage read-only.
3. Verify: row counts per key table vs. production report, login works, a random sample of receipts/slips regenerates identically.
4. Record date, duration, issues in this file.

## In-app Super Admin "Backups" page (Phase 14)

Shows last successful backup time & status (from the backup job's report), triggers an on-demand export of school data (ZIP of CSV/JSON per module, encrypted with a passphrase), and lists restore drill history. Restores are performed by operators, not from the web UI.

## Drill log

| Date | Environment | Method | Result | Notes |
|---|---|---|---|---|
| 2026-11-08 | **Local** throwaway PostgreSQL 18.6 (not Neon) | `scripts/backup-drill.ts` (logical JSON export → restore into freshly migrated empty DB) | **Passed** — 15/15 tables identical (counts + md5 checksums; 13 roles, 79 permissions, 256 grants, 7 users, 43 audit rows); restored DB accepted new writes; re-run correctly refused a non-empty target. Backup 57.5 KB / 44 ms, restore 25 ms. | Drill copy deleted afterwards. |
| 2026-11-08 | Local | `pg_dump -Fc` / `pg_restore` | **Not run** | Executing the downloaded PostgreSQL client binaries was blocked by the tool permission policy. To be run by the owner (or with approval) against Neon. |
| — | Neon | PITR branch restore | **Not run** | Neon project not yet connected. |
