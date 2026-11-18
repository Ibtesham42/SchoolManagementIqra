# Phase 2a — Database Verification Checklist

Status: **prepared 2026-11-09, not started.** Nothing in this checklist has been run. Neon has not been connected, no migration has been applied, nothing has been seeded.

This checklist verifies **both** pending migrations (Phase 1 `20261108000000_init` and Phase 2a `20261109000000_phase2a_files_documents_settings`) and closes the database items of Phase 1 and Phase 2a together. It builds on [NEON_SETUP_GUIDE.md](NEON_SETUP_GUIDE.md) (Steps 0–7); where the two differ, **this checklist's expected values win** (the guide's Step 7 counts predate Phase 2a).

## Legend

| Mark | Who | Meaning |
|---|---|---|
| 👤 | **Owner only** | Neon console, secrets, passwords, browser sign-in, approvals. Claude Code cannot do these: it can't read `.env`/`.env.test` and must never see connection strings, keys or passwords. |
| 🤖 | **Claude, after the named gate** | Commands that load `.env` themselves and print only ✓/✗, counts and masked hosts — never values. Claude runs them **only after you approve that gate in chat, naming the branch**. You may also run them yourself. |
| 🔒 G*n* | **Approval gate** | Nothing after a gate runs until you write e.g. "Approve G2 (development)". Approval for one gate never implies the next. |
| ⛔ | **Never** | Forbidden at every stage. |

⛔ **Never, at any step:** `prisma migrate reset`, `prisma db push`, `prisma migrate dev` against Neon, editing an applied migration, `prisma migrate resolve --applied` without proof the SQL ran, any command with production connection strings loaded, pasting secrets into chat/docs/commits, seeding the `test` branch from `.env.test` by hand, running anything against production.

## Approval gates (in order)

| Gate | Allows | Branch |
|---|---|---|
| 🔒 G1 | Read-only connections: `env:check`, `prisma migrate status`, `db:check` | development + test |
| 🔒 G2 | `db:deploy` (both migrations) | **development** |
| 🔒 G3 | `db:seed` | **development** only |
| 🔒 G4 | `db:deploy` (both migrations) | **test** |
| 🔒 G5 | Integration suite (34 tests) — writes synthetic rows to the test branch | **test** |
| 🔒 G6 | Backup/restore drill | development → disposable target |
| 🔒 G7 | Local dev server connected to development; signed-in UI checks; optional DB e2e | **development** |

---

## A. Already verified offline (no action)

| Check | Result (2026-11-09) |
|---|---|
| `prisma validate`, client generated | ✓ |
| Offline SQL consistency (`prisma migrate diff --from-schema --to-schema` vs. migration file) | ✓ all 13 generated statements present; 9 intentional additions + 1 guard block |
| Static migration review (`tests/unit/migration-phase2a.test.ts`) | ✓ transaction, guard first, backfill order, 6 CHECKs fully validated, key version, FK rules, no `school_id` |
| Table list covers schema + FK order (`tests/unit/db-tables.test.ts`) | ✓ 16 tables, 13 foreign keys |
| typecheck · lint · check:deps · unit tests · build | ✓ (see DEVELOPMENT_PROGRESS) |

---

## B. Neon development and test branch setup — 👤

Follow NEON_SETUP_GUIDE Steps 0–3, then confirm:

- [ ] 👤 **B1** Node 26 in the terminal (`node -v` → v26.x) — Claude may also run this.
- [ ] 👤 **B2** The previously exposed Neon password has been **reset** (Step 1). Old strings are dead.
- [ ] 👤 **B3** Branches exist: `production` (default, untouched), `development`, `test` — both created from the **empty** default branch *before* any production data existed. If production already holds data, create `development`/`test` as **schema-only/empty** branches or from an empty point in time — never copy production data into them.
- [ ] 👤 **B4** Note (on paper or in the password manager, **not** in chat) each branch's **ID** (`br-…`) and **endpoint host** (`ep-…`). Both branches use database `neondb`; the endpoint host is the only way to tell them apart.
- [ ] 👤 **B5** Pooled (`-pooler`) and direct strings copied for development and test only. **Never** copy the production strings anywhere on this machine.

## C. Production branch protection — 👤 (+ 🤖 after G1)

- [ ] 👤 **C1** No production connection string exists in `.env`, `.env.test`, shell history, or any file in the project.
- [ ] 👤 **C2** In the PowerShell window used for all later steps: `$env:FORBIDDEN_BRANCH_IDS = "<production branch id>"` (branch **ID**, not a secret).
- [ ] 👤 **C3** If your Neon plan offers *protected branches*, mark `production` protected. (Not relied on — C1, C2 and C5 are the controls.)
- [ ] 👤 (G1) **C4b** Endpoint guard proof — refused **before connecting**: `try { $env:FORBIDDEN_ENDPOINT_IDS = "<development endpoint id>"; npm run env:check } finally { Remove-Item Env:FORBIDDEN_ENDPOINT_IDS -ErrorAction SilentlyContinue }` → must fail with "DATABASE_URL points to an endpoint in FORBIDDEN_ENDPOINT_IDS … refusing to connect" and "no connection was attempted".
- [ ] 👤/🤖 (G1) **C4** Guard proof: set `FORBIDDEN_BRANCH_IDS` to the **development** ID, run `npm run env:check` → **must fail** with "development branch is in FORBIDDEN_BRANCH_IDS (e.g. production) — refusing" and "ENV CHECK FAILED — do not migrate or seed". Then set it back to the production ID.
- [ ] **C5** Every database command below runs only after the 7.0 check (D0) in the same window.

## D. Environment variable preflight — 👤 (+ 🤖 after G1)

`.env` (development) — 👤 owner edits; Claude never reads it. Required lines (values never shown here):

| Variable | Note |
|---|---|
| `DATABASE_URL` / `DIRECT_URL` | development pooled / development direct |
| `TEST_DATABASE_URL` | **test** pooled — used only by the integration suite (`tests/setup.ts` swaps it in) |
| `APP_URL` | `http://localhost:3000` |
| `SESSION_SECRET`, `DATA_ENCRYPTION_KEY`, `DATA_HMAC_KEY`, **`DOCUMENT_VERIFICATION_KEY`** | four **different** 32-byte keys (Step 5 — now four keys) |
| `DATA_ENCRYPTION_KEY_VERSION=1`, `DOCUMENT_VERIFICATION_KEY_VERSION=1` | no `DOCUMENT_VERIFICATION_KEY_V<n>` yet |
| `PRIVATE_STORAGE_DRIVER=local`, **`PRIVATE_STORAGE_LOCAL_DIR`** | absolute path **outside** the project (e.g. a folder in your user profile); the app refuses paths inside `public/` or `.next/`. Needed for logo upload in section I |
| `SEED_SUPERADMIN_USERNAME`, `SEED_SUPERADMIN_PASSWORD` | for G3 |

`.env.test` (test-branch migrations only) — 👤: `DATABASE_URL`/`DIRECT_URL` = **test** pooled/direct (NEON_SETUP_GUIDE Step 4b).

- [ ] 👤 **D0 (before every DB command — "7.0")** `Test-Path Env:DATABASE_URL; Test-Path Env:DIRECT_URL; Test-Path Env:DOTENV_PATH` → all `False`. Otherwise open a new window.
- [ ] 🤖 (no gate — never connects) **D0b** `npm run env:check:offline` → `ENV CHECK PASSED` (files, names, key lengths/separation, URL shapes, `.env.test` endpoint matches `TEST_DATABASE_URL`, storage folder outside the project).
- [ ] 🤖 (G1) **D1** `npm run env:check` (requires `FORBIDDEN_BRANCH_IDS` and `FORBIDDEN_ENDPOINT_IDS` — it refuses to connect without either; forbidden endpoints are refused before any connection) → ends with `ENV CHECK PASSED`: 8 required variables present; 3 data keys 32 bytes and distinct; no invalid `DOCUMENT_VERIFICATION_KEY_V<n>` names; pooled/direct on the same branch; test ≠ development; neither branch forbidden; SSL require/verify-full.
- [ ] 🤖 (G1) **D2** `npx prisma migrate status` → host is the **development** `ep-…` (compare with B4) and **2 migrations not yet applied**: `20261108000000_init`, `20261109000000_phase2a_files_documents_settings`.
- [ ] 🤖 (G1) **D3** Test branch, same check: `try { $env:DOTENV_PATH = ".env.test"; npx prisma migrate status } finally { Remove-Item Env:DOTENV_PATH -ErrorAction SilentlyContinue }` → **test** `ep-…` host, 2 pending. Then `Test-Path Env:DOTENV_PATH` → `False`.

**Stop if:** any ✗, an unexpected host, a migration count other than 2 pending, or any applied migration you don't recognise.

## E. Migration execution order

Order: **development first** (deploy → check → seed), then **test** (deploy → check). Never production.

- [ ] 👤 **E0** Write down the current time (UTC) for each branch just before deploying — the point-in-time restore target if anything goes wrong (Neon Free keeps 6 h).
- [ ] 🤖 (G2) **E1** Development: D0, then `npm run db:deploy` → "2 migrations applied" (init, then phase2a; Prisma applies in folder-name order).
- [ ] 🤖 (G2) **E2** Development: `npm run db:check` → expect:
  - pgvector enabled; **migrations applied: 2/2**, both ✓;
  - **all 16 model tables present** (incl. `generated_document`);
  - **"6 Phase 2a CHECK constraints validated, 4 foreign keys with expected ON DELETE rules"**;
  - no "legacy file(s) without the LegacyFile/<id> owner" line;
  - size well under the 512 MB budget.
- [ ] 👤 **E3a** Seed allow-list in `.env` (ids, not secrets — or re-run `setup:env`): `Add-Content .env "SEED_TARGET_BRANCH_ID=<development branch id>"` and `Add-Content .env "SEED_TARGET_ENDPOINT_ID=<development endpoint id>"`; then `npm run env:check:offline` must show "SEED_TARGET_ENDPOINT_ID matches DATABASE_URL (development) and is not forbidden".
- [ ] 🤖 (G3) **E3** Development seed: D0, `npm run db:seed` (never `prisma db seed`) → "✓ target configuration …", "✓ server identity …", "✓ committed: permissions +80 …, roles +13, grants +260 …, settings created", "✓ Super Admin created (password change required on first sign-in)", "Seed complete: 80 permissions, 13 roles, 260 role grants." Any ✗ = nothing was written (one transaction).
- [ ] 🤖 (G3) **E4** `npm run db:check` again → row counts: permission 80, role 13, role_permission 260, user 1, school_setting 1.
- [ ] 🤖 (G4) **E5** Test branch: `try { $env:DOTENV_PATH = ".env.test"; npm run db:deploy; npm run db:check } finally { Remove-Item Env:DOTENV_PATH -ErrorAction SilentlyContinue }` → same expectations as E2 (tables empty). **Do not seed `test`** (the integration suite creates what it needs). `Test-Path Env:DOTENV_PATH` → `False`.

## F. Migration failure and recovery

The Phase 2a migration is wrapped in `BEGIN … COMMIT` and starts with a read-only guard. **First real-world confirmation:** that Prisma applies the explicit transaction cleanly — record any warning text (no secrets) in the result log.

| Symptom | Meaning | Recovery |
|---|---|---|
| `Migration 20261109000000 aborted: …` (guard) | Existing data can't meet the new rules. **Nothing was changed.** On new, empty branches this cannot happen. | 1. Don't retry blindly — report the message. 2. Fix the cause (data review, owner decision). 3. 🤖 (with approval) `npx prisma migrate resolve --rolled-back 20261109000000_phase2a_files_documents_settings` to clear Prisma's "failed" mark. 4. Re-run `db:deploy`. |
| Any other SQL error during Phase 2a | Transaction rolled back; database as before the migration. | Same as above: capture the error, `migrate resolve --rolled-back …`, fix, redeploy. |
| Error during `init` | Branch is new/disposable. | 👤 delete and recreate the branch (simplest, cleanest), redo D/E for it. |
| `migrate status` / `db:check` disagree or state is unclear | Unknown partial state | 👤 stop; restore the branch to the E0 time in the Neon console (or delete/recreate — these branches hold no real data yet); re-check with D2/D3 before anything else. |
| Network drop mid-deploy | Unknown | Treat as "state unclear" above. Never `resolve --applied`. |

⛔ Recovery never uses `migrate reset`, `db push`, manual edits of `_prisma_migrations`, or editing the migration file after it has been applied anywhere.

## G. Integration tests — all 34 (🤖 after G5, test branch)

Command (D0 first; `.env` must contain `TEST_DATABASE_URL` = **test** pooled):
```powershell
npm run test:integration -- --no-file-parallelism   # the ONLY command that runs integration tests (KI-043)
npm test                                            # unit tests only — never touches a database
```
Expected: **39 passed, 0 skipped** (integration — 34 + 5 seed tests) and `npm test` green (unit only). A skip means `TEST_DATABASE_URL` was not loaded — that is a failure of this step, not a pass.

| # | File | Test | Verifies |
|---|---|---|---|
| 1 | documents | prints the code on the PDF, stores only its hash, and keeps the PDF PRIVATE and owned | hash + key version stored, no raw code anywhere, PDF private/encrypted/owned |
| 2 | documents | verifies with minimal information, accepting typed variations | public answer fields only |
| 3 | documents | a revoked document fails verification; revoking twice conflicts | School Admin can't revoke, Principal can, audit row |
| 4 | documents | the PDF is never public and is bound to its own registry entry | anonymous/no-owner/wrong-owner → 404 |
| 5 | documents | teachers can neither issue nor revoke | RBAC |
| 6 | documents | the database refuses a raw (non-hash) verification code | CHECK `generated_document_code_hash_format` |
| 7 | identity-admin | creates a user with a one-time temporary password that forces a change | |
| 8 | identity-admin | rejects duplicate usernames and emails with friendly conflicts | |
| 9 | identity-admin | role changes take effect on the next request; deactivation ends sessions | |
| 10 | identity-admin | delegated admins cannot touch Super Admins or escalate | |
| 11 | identity-admin | keeps at least one active Super Admin, even under concurrent deactivation | ADR-025 lock |
| 12 | identity-admin | race: 'remove Super Admin role from A' vs 'deactivate B' never leaves zero Super Admins | |
| 13 | identity-admin | a delegated admin cannot reset the password of a more-privileged user (account takeover) | |
| 14 | identity-admin | system role is immutable; custom roles can be created, edited and deleted | |
| 15 | identity-admin | password reset: neutral for unknown users, single-use link, ends sessions | |
| 16 | identity-admin | cleanup removes expired sessions and buckets only | |
| 17 | phase1 | 50 concurrent sequence calls yield 50 unique consecutive numbers | `lib/sequence` |
| 18 | phase1 | a rolled-back transaction does not consume a sequence number | |
| 19 | phase1 | login creates a session whose context carries scoped permissions; revocation ends it | |
| 20 | phase1 | locks the account after repeated failures with a generic error | |
| 21 | phase1 | all 13 roles: permissions loaded from the DB through a real session match the catalog exactly | 80 permissions incl. `document.revoke` |
| 22 | phase1 | deactivated users' sessions stop working immediately | |
| 23 | phase1 | audit entries roll back with their transaction (no orphan audit rows) | |
| 24 | phase1 | 50 parallel sequence calls on independent connections (true concurrency) stay unique | |
| 25 | phase1 | rate limiter blocks after the limit within a window | |
| 26 | phase1 | usage guard stops at the cap and never calls past it | |
| 27 | settings-files | saves the school profile (Super Admin) with an audit row, and forbids a teacher | regional fields persisted |
| 28 | settings-files | uploads a logo, serves it publicly, and retires the previous one on replacement | logo FK, cache eviction |
| 29 | settings-files | rejects a non-image logo without creating a file row | rollback, no orphan |
| 30 | settings-files | legacy 'unclassified' files stay Super Admin–only and can still be retired | KI-039 regression; `publiclyReadable=false` |
| 31 | settings-files | the database refuses PRIVATE files that are unencrypted, unversioned or ownerless | CHECKs `stored_file_private_*` |
| 32 | settings-files | runs the session lifecycle: create → edit → activate → current → close guard | advisory lock, rules |
| 33 | settings-files | School Admin can manage settings and sessions (owner decision), audited under their name | |
| 34 | settings-files | refuses overlapping and duplicate sessions, and forbids a teacher | |

Notes: the suite writes **synthetic** rows to the test branch (usernames prefixed with a run id, far-future session years) and cleans up most of them; the singleton `school_setting` row is left with "Demo Public School" data. Re-running is safe.

## H. Post-migration schema verification

- [ ] 🤖 (G1, after E2/E5) **H1** `npm run db:check` — automated catalogue checks listed in E2 (tables, 6 CHECKs `convalidated`, 4 FK delete rules, legacy-owner invariant).
- [ ] 🤖 (G1) **H2** Drift check, development: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` → exit code **0** (empty diff). Prisma ignores CHECK constraints, so H1 covers those. Test branch: same inside the `DOTENV_PATH` try/finally.
- [ ] 🤖 (G1) **H3** `npx prisma migrate status` on both branches → "Database schema is up to date".
- [ ] 👤 **H4** Optional spot checks in the Neon SQL editor (development; read-only):
  ```sql
  SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'stored_file_%' OR conname LIKE 'generated_document_%' ORDER BY 1;
  SELECT column_name, data_type, character_maximum_length, column_default, is_nullable
    FROM information_schema.columns
   WHERE (table_name = 'stored_file' AND column_name IN ('purpose','owner_type','owner_id'))
      OR (table_name = 'school_setting' AND column_name IN ('locale','currency','date_format','created_at'))
      OR (table_name = 'generated_document' AND column_name IN ('verification_code_hash','verification_key_version','updated_at'))
   ORDER BY table_name, column_name;
  SELECT indexname FROM pg_indexes WHERE tablename IN ('stored_file','generated_document') ORDER BY 1;
  ```
  Expected: all listed constraints `true`; `purpose` varchar(40) NOT NULL no default; `owner_id` varchar(64); `locale` 'en-IN', `currency` 'INR', `date_format` 'DD/MM/YYYY'; `verification_code_hash` character(64); `verification_key_version` smallint, no default; indexes incl. `stored_file_owner_type_owner_id_idx`, `generated_document_verification_code_hash_key`, `generated_document_file_id_key`.

## I. Backup and restore verification (G6)

Development holds only the seed (G3) at this point — that is what is drilled. Design: ADR-033. Every step needs its own owner approval.

**Drill targets** are disposable **children of development** with an expiry (`--expires-at`), never production, development or test. ⚠️ The Neon CLI's `--parent` defaults to **production** — always give an explicit parent (or use the API with `parent_id`).

- [ ] 👤 **I0** Tools in place (G6-0, done): `npm run drill:env`, `npm run backup:drill`, `npm run files:backup`, `npm run files:verify`.
- [x] **G6-A — logical drill** (passed 2026-11-09). Target = a **point-in-time child of development** taken at a moment when the schema exists but the app tables are empty (after the migrations, before the seed), *not* a schema-only branch: Neon creates schema-only branches as root branches, which `drill:env` refuses (the target must be a child of development). Steps:
  1. 🤖 (after approval) pre-checks: current 6 h history window and the requested timestamp inside it; parent id = development (not production/test); branch name unused; forbidden lists set (`env:check:offline`).
  2. 🤖 create via the API with an explicit parent — never a bare timestamp (that branches from the default/production branch): `neonctl api /projects/<id>/branches -X POST -d '{"branch":{"name":"logical-drill","parent_id":"<development branch id>","parent_timestamp":"<UTC>","expires_at":"<now+24h UTC>"},"endpoints":[{"type":"read_write"}]}'`, printing only ids/timestamps (the response contains connection strings).
  3. 🤖 read-only metadata: branch id, parent = development, **recorded** `parent_timestamp` (Neon may record an earlier time than requested — stop and get owner acceptance; it must still fall between the migrations and the seed), one read-write endpoint whose host matches its id, expiry.
  4. 👤 `npm run drill:env -- --project-id <id> --branch logical-drill` (interactive; writes `.env.restore.local`) · 🤖 offline checks: the file exists (not read), `env:check:offline`, `drill:env … --dry-run`.
  5. 🤖 (after approval) `npm run backup:drill` → SOURCE read-only on development, TARGET identity + **all 16 tables empty** (this also proves the snapshot had no app rows), `backup: 16 tables`, restore committed, **16/16 identical**, write check ✓ (new `audit_log` id > restored max; rolled back), `DRILL PASSED`. Optional 👤 `-- --out <abs path>.scbak` (encrypted, passphrase prompt).
  6. 👤 delete the branch (or let it expire) and `.env.restore.local`.
- [ ] **G6-B — `pg_dump`/`pg_restore`: DEFERRED to Phase 10** (needs PostgreSQL 18 client tools; installed tools are 17.11, the server is 18.6).
- [ ] **G6-C — point-in-time restore.** 🤖 (after approval) create `pitr-drill` from development at a timestamp after the G3 commit, inside Neon Free's 6 h history window (API with explicit `parent_id` + `parent_timestamp`, `expires_at`); 🤖 read-only verification via `neonctl psql <pitr branch id>` (server branch printed; aggregate counts only); optional 👤 `npm run drill:env -- --branch pitr-drill` then 🤖 `DOTENV_PATH=.env.restore.local npm run db:check` and a drift check.
- [x] **G6-D — files and keys** (PASSED 2026-11-09 — tooling verification only, 0 stored files; real private-file drill = KI-047, open). 🤖 `npm run files:verify` (live store vs `stored_file`) · 👤 `npm run files:backup -- --dest <abs folder outside project and store>` then `npm run files:verify -- --dest <same>` · 👤 confirm every secret in BACKUP_AND_RECOVERY.md → "Keys and secrets needed for recovery" is in the password manager. With 0 `stored_file` rows this is a tooling check only — record it as partial; the real private-file drill is KI-047.
- [ ] 🤖 **I7** Record each drill (date, method, result, durations — never URLs) in BACKUP_AND_RECOVERY.md → Drill log. 👤 delete drill branches (or let them expire) and `.env.restore.local` afterwards.

## J. Signed-in ERP UI verification (G7, development)

- [x] 🤖 (G7) **J1** Start `npm run dev` (connects to development). Claude does not sign in.
- [x] 👤 **J2** Sign in as the seeded Super Admin → forced password change works → new password (keep it private).
- [x] 👤 **J3** Check each screen at **360 px, 768 px, 1280 px** (browser dev tools): no horizontal scroll, single-column forms on mobile, touch targets ≥ 44 px, visible focus, mobile bottom bar with **More** sheet.

| # | Screen / action | Expected |
|---|---|---|
| J4 | `/erp/settings` → save profile with a bad PIN, an http website, closing before opening | field errors under each field; nothing saved |
| J5 | Save a valid profile incl. language/region, currency, date format, time zone | "School profile saved."; values persist after reload |
| J6 | Upload a PNG/JPEG logo ≤ 800 KB | logo shown; header/documents use it |
| J7 | Upload a renamed `.html`/`.svg` as `logo.png`; upload a file > 800 KB | clear rejection; no change |
| J8 | Remove logo (confirm dialog) | logo gone; "No logo" placeholder |
| J9 | "Preview document (PDF)" | A4 PDF with school name, logo, address, footer "Generated …" in the school time zone, "Page X of Y"; no personal data |
| J10 | `/erp/settings/sessions`: create 2026-27 (1 Apr 2026–31 Mar 2027) | Planned; dates shown without day shift |
| J11 | Create an overlapping session; a name not matching the dates | rejected with clear messages |
| J12 | Edit planned → Activate → Make current → try Close on the current one | close not offered for current; activate/current work; badges correct |
| J13 | Users → create a **School Admin** user; sign in as them (private window) | Settings visible and editable; sessions manageable; **no** Users/Roles management actions |
| J14 | Create a **Teacher** user; sign in | no Settings in navigation; `/erp/settings` → "not permitted"; `/api/v1/documents/preview` → 403 |
| J15 | Signed out: open the logo URL | logo loads (public); a random `/api/v1/files/<id>` → 404 |
| J16 | 👤 Neon SQL editor (read-only): `SELECT action, count(*) FROM audit_log GROUP BY 1 ORDER BY 1;` | `settings.profile_update`, `settings.logo_update`, `settings.logo_remove`, `file.upload`, `file.retire`, `session.*` present; no secret or Aadhaar-like values in `before/after` |

**G7 status (2026-11-10): PASSED** (J17 optional, not run). J1–J16 ✓ and demo-account clean-up ✓ on Neon `development` only. Bugs found and fixed during G7: B1 (KI-049), B2 (KI-048), B3 (KI-050), B4 (KI-051), B5 (KI-052); J5, J7, J9 and J13 re-run ✓ after the fixes. J10–J12 and the clean-up were accepted by the owner on the recorded evidence. **J16 ✓** (Claude, owner-authorised read-only run on 2026-11-10 instead of the owner's SQL-editor run): identity project SchoolMang / `br-morning-scene-aoxm8ctk` / `ep-quiet-river-aoywr8xg`, read-only; 15 actions / 29 rows exactly as expected; before/after scan of 17 rows: no secrets, hashes, tokens or Aadhaar-like values (3 `roleKeys` flags were role names — false positives). Runtime for G7 was Node 22.23.4 (KI-009). Evidence: LOCAL_UI_AUDIT.md §20.

- [ ] 🤖 (G7, optional — **not run**, not a failure; needs separate approval) **J17** Phase 1 database e2e suite (33 tests): `npm run build` → standalone server → `E2E_BASE_URL=… E2E_DATABASE_URL=<you set it in your window> npm run test:e2e` (TESTING_STRATEGY "Running the suites"). The URL is set by you in the terminal, not by Claude.
- [x] 🤖 **J18** Record the UI results in LOCAL_UI_AUDIT.md (new "signed-in" section) — observations only, no credentials.

## K. Sign-off

- [ ] 🤖 Record every result (commands, ✓/✗, counts — never values) in DEVELOPMENT_PROGRESS.md.
- [ ] 🤖 Update KNOWN_ISSUES: KI-001, KI-031, KI-035, KI-036, KI-039, KI-041 → resolved where verified.
- [ ] 👤 Owner decision: Phase 1 sign-off; Phase 2a sign-off. Until then both stay **In Progress**. Phase 3 does not start before sign-off.

## Expected values (quick reference)

| Item | Value |
|---|---|
| Migrations | 2 (`20261108000000_init`, `20261109000000_phase2a_files_documents_settings`) |
| Tables | 16 (`scripts/db-tables.ts`) |
| Foreign keys | 13 (9 init + 4 Phase 2a) |
| Phase 2a CHECK constraints | 6, all validated |
| Seed | 80 permissions · 13 roles · 260 role grants · 1 Super Admin · 1 settings row |
| Integration tests | 34 passed, 0 skipped |
| Keys in `.env` | 4 distinct (session, encryption, HMAC, document verification) |
