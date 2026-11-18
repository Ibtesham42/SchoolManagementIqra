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
- **Application-level drill (ADR-033):** `npm run drill:env -- --project-id <id> --branch <drill branch>` (owner; writes `.env.restore.local`), then `npm run backup:drill` — reads development in a read-only session, restores into the disposable drill branch (identity-checked, must be empty), resets identity sequences, verifies per-table counts + checksums, then a rolled-back write check (the new `audit_log` id must exceed the restored max). Both sessions run in UTC with ISO dates and read date/time columns as text, so `date` values cannot shift on a machine outside UTC (rows holding JS Dates are refused). The drill branch must be a **child of development** — use a point-in-time branch taken after the migrations and before any data (checklist G6-A); Neon's schema-only branches are root branches and `drill:env` refuses them. No connection strings on the command line. `-- --out <abs path>.scbak` additionally writes an **encrypted** backup (AES-256-GCM, scrypt passphrase; outside the project and the file store; never overwritten).
- **File store:** `npm run files:backup -- --dest <abs folder>` copies every blob as stored (private files stay encrypted) plus a manifest (format `schoolerp-files-2`) of storage keys, sizes and blob hashes — no file names, nothing decrypted, and **no content hash for private files** (a plaintext hash would let anyone holding the backup confirm a guessed document; format-1 manifests from G6-0 are still readable). `npm run files:verify [-- --dest <folder>]` checks every blob against its manifest hash, decrypts private files and compares the result with `stored_file.sha256` from the database, and reports missing live blobs, blobs the manifest omits and manifest entries the database doesn't know (counts and categories only). Back up `PRIVATE_STORAGE_LOCAL_DIR` together with the database, and the keys below separately — without them a restore is unreadable / unverifiable.

## Keys and secrets needed for recovery

Store each of these in the school's **password manager** (an owner-controlled vault with 2FA and a second trusted administrator for emergency access), recorded per installation with the date it was set. **Never** put them in a backup folder, next to a backup, in the project, in documentation, in tickets, chat or logs, or in Claude Code memory. The values live only in the vault and the server's environment.

| Secret | Why recovery needs it |
|---|---|
| `DATA_ENCRYPTION_KEY` | Decrypts private files and encrypted fields (Aadhaar, PAN, bank) written under the current version |
| `DATA_ENCRYPTION_KEY_VERSION` | Tells the app which version the current key is; a wrong value makes every file of that version undecryptable |
| `DATA_ENCRYPTION_KEY_V<n>` (each rotated-out version) | Decrypts data still written under version `<n>`; keep until re-encryption has finished |
| `DATA_HMAC_KEY` | Lookup hashes (Aadhaar duplicate detection). Losing it does not lose data, but every stored lookup hash stops matching — duplicates would go undetected |
| `DOCUMENT_VERIFICATION_KEY` | Verifies codes on issued documents (current version) |
| `DOCUMENT_VERIFICATION_KEY_VERSION` | Which version the current verification key is |
| `DOCUMENT_VERIFICATION_KEY_V<n>` (where rotated) | Keeps documents issued under version `<n>` verifiable |
| `.scbak` backup passphrase(s) | Decrypts encrypted logical backups (`backup:drill --out`); one per backup set, recorded with its date |

Not needed for recovery: `SESSION_SECRET` (a new value only signs everyone out and resets rate-limit buckets), database URLs (re-issued by Neon), seed credentials.

## Recovery sequence (database + files)

1. **Restore the database** — Neon point-in-time branch or a logical backup into a fresh, migrated, empty database (see the drill steps in PHASE_2A_DB_VERIFICATION_CHECKLIST.md G6-A/G6-C). Never restore over production without the owner's explicit approval.
2. **Restore the keys** from the password manager into the server environment: every variable in the table above with the same values and version numbers as at backup time. Run `npm run env:check:offline` (key lengths and separation).
3. **Restore the files** — copy the backup folder's `public/` and `private/` trees into an **empty** `PRIVATE_STORAGE_LOCAL_DIR`, keeping the relative paths (the storage key is the path). Do not copy `manifest.json` into the store; keep it with the backup. Private blobs are restored as stored (still encrypted). There is no `files:restore` command yet (KI-047).
4. **Run `npm run files:verify -- --dest <backup folder>`** (backup vs database) and then **`npm run files:verify`** (restored store vs database). Both must report 0 problems: every live `stored_file` row has its blob, every blob matches its hash, every private blob decrypts with the restored keys to its recorded hash.
5. **Confirm the references** — the verify run reports blobs the database doesn't know and live rows without a blob; investigate any before going live. Then sign in and open a few files of each purpose (logo, documents).

### Database and file backups are not atomic

The database backup and `files:backup` are separate steps taken at different moments, so a pair can be temporarily inconsistent: a file uploaded between the two appears as a manifest entry the database doesn't know (DB taken first) or as a live row with no blob (files taken first). Take both within the same quiet window (no uploads), take the database first and the files immediately after, and treat `files:verify` problems on a restore as a signal to compare timestamps before deleting anything. Soft-deleted rows whose blob has gone are expected and are not reported.
- **Neon CLI caution:** `neonctl branches create --parent` defaults to the **production** branch; always pass an explicit parent.

## Restore drill (each term)

1. Create a fresh database; `pg_restore` latest dump.
2. Point a staging deployment at it with storage read-only.
3. Verify: row counts per key table vs. production report, login works, a random sample of receipts/slips regenerates identically.
4. Record date, duration, issues in this file.

## In-app Super Admin "Backups" page (Roadmap Phase 10 — planned, not implemented)

Shows last successful backup time & status (from the backup job's report), triggers an on-demand export of school data (ZIP of CSV/JSON per module, encrypted with a passphrase), and lists restore drill history. Restores are performed by operators, not from the web UI.

## Drill log

| Date | Environment | Method | Result | Notes |
|---|---|---|---|---|
| 2026-11-08 | **Local** throwaway PostgreSQL 18.6 (not Neon) | `scripts/backup-drill.ts` (logical JSON export → restore into freshly migrated empty DB) | **Passed** — 15/15 tables identical (counts + md5 checksums; 13 roles, 79 permissions, 256 grants, 7 users, 43 audit rows); restored DB accepted new writes; re-run correctly refused a non-empty target. Backup 57.5 KB / 44 ms, restore 25 ms. | Drill copy deleted afterwards. |
| 2026-11-08 | Local | `pg_dump -Fc` / `pg_restore` | **Not run** | Executing the downloaded PostgreSQL client binaries was blocked by the tool permission policy. To be run by the owner (or with approval) against Neon. |
| 2026-11-09 | Neon | PITR branch restore (G6-C) | **Passed** | Branch `pitr-drill` created 14:40:42Z UTC from development via the API (explicit parent id); requested 14:15:00Z, Neon recorded **14:14:16Z** (28 s after the G3 seed commit; accepted by the owner). Expiry applied (2026-11-10 15:00Z). Read-only session (`transaction_read_only = on`, server branch/endpoint = the drill branch): permissions 80, roles 13, role_permission 260, users 1, user_role 1, 1 active Super Admin with mustChangePassword, school_setting 1, audit_log 2 (newest 14:13:45Z ≤ snapshot), 2 migrations finished, Argon2id hash ✓, no hash in audit, all other tables 0. Development unchanged (identical counts). Branch kept until owner approval (auto-expiry tomorrow). |
| 2026-11-09 | Neon | Logical drill (G6-A): `npm run backup:drill`, in-memory only | **Passed** | Target `logical-drill` (`br-sparkling-wave-aowwzjql` / `ep-rough-block-ao76dl7a`) created 15:17:25Z UTC via the API as a point-in-time child of development (explicit parent id); requested 14:05:00Z, Neon recorded **13:15:28Z** (after the G2 migrations, before the G3 seed; accepted by the owner); expiry 2026-11-10 15:00Z. A schema-only branch was not used: Neon creates those as root branches, which `drill:env` refuses. Run 15:22:24–15:22:37Z: SOURCE read-only on development + live identity ✓; TARGET identity ✓, all 16 tables empty ✓; backup 16 tables, 38.9 KB / 2025 ms; restore committed in 1308 ms; **16/16 tables identical** (counts + md5: 13 roles, 80 permissions, 260 grants, 1 user, 1 user_role, 1 school_setting, 2 audit rows, others 0); write check rolled back ✓. No backup file written. |
| 2026-11-09 | Neon development + local store | G6-D step 2: `npm run files:verify` (live store vs `stored_file`, read-only session) | **Passed — tooling only (0 stored files)** | 15:36:33–15:36:37Z UTC, exit 0: read-only session and live identity confirmed before reading; 0 rows, 0 blobs, 0 problems. Nothing to decrypt yet, so the key round-trip is not proven against real data (KI-047). Owner then ran `files:backup -- --dest <folder outside project and store>` and `files:verify -- --dest <same>`: both reported successful by the owner (output not shared; with 0 rows the backup holds an empty manifest only). Owner confirmed every applicable secret in "Keys and secrets needed for recovery" (including still-required old key versions) is in the password manager; no `.scbak` passphrase exists because no encrypted backup has been created. **G6-D PASSED (tooling only); KI-047 stays open for a real private-file drill.** |
| — | Neon | `pg_dump`/`pg_restore` (G6-B) | **Deferred to Phase 10** | Needs PostgreSQL 18 client tools (installed: 17.11; server 18.6). |
