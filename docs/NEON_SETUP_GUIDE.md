# Neon Setup Guide — Phase 1 Database Verification

> **Status:** approved 2026-11-08. Owner-performed steps; nothing here has been executed yet.
> **Scope:** create the `development` and `test` branches, configure local environment files safely, prove the production branch is protected, and review/apply the first migration. Free tier only (docs/FREE_TIER.md).
>
> **Never** paste connection strings, passwords or keys into chat, documents, issues or commits. They belong only in your local `.env` / `.env.test`, which are git-ignored and blocked from Claude Code.

---

## Step 0 — Prerequisites
1. Install **Node.js 26** (nodejs.org). Open a **new** PowerShell window; `node -v` must print `v26.x`.
2. Work from the project folder: `cd D:\AnacondaProj\SchoolMang\SchoolMang`.

## Step 1 — Secure the exposed password and identify production
A `neondb_owner` password was exposed earlier in a chat session.

1. Neon Console → project → **Branches**. The **default** branch is **`production`** (rename it if needed).
2. `production` branch → **Roles** → `neondb_owner` → **Reset password**.
3. **Roles are copied per branch at creation.** Any `development`/`test` branch created *before* the reset still has the old password → reset `neondb_owner` on those branches too (or delete and recreate them).
4. Note the **production branch ID** (`br-…`, shown on the branch page). It is not secret; Step 6 uses it.

## Step 2 — Create the `development` and `test` branches
1. **Branches → New branch** → name `development`, parent `production`, data from the current point in time (production is empty).
2. Repeat with name `test` (parent `production`). Test suites create and delete their own data only there.
3. Each branch gets its own compute endpoint (`ep-…`). Computes sleep after 5 idle minutes; normal use stays well inside 100 CU-hours/month.
4. **Never create objects or run commands on `production`.** It stays empty until go-live (Roadmap Phase 10).

## Step 3 — Get the connection strings
Project dashboard → **Connect**. Choose **Branch**, **Database** (`neondb`), **Role** (`neondb_owner`) and the **Connection pooling** toggle.

| Where it goes | Branch | Pooling | Recognise it by |
|---|---|---|---|
| `.env` → `DATABASE_URL` | `development` | **On** | host contains `-pooler` |
| `.env` → `DIRECT_URL` | `development` | **Off** | host has **no** `-pooler` |
| `.env` → `TEST_DATABASE_URL` | `test` | **On** | `-pooler`, a different `ep-…` than development |
| `.env.test` → `DATABASE_URL` | `test` | **On** | same as the line above |
| `.env.test` → `DIRECT_URL` | `test` | **Off** | test `ep-…`, no `-pooler` |

- Always confirm the **Branch** selector before copying (an earlier string came from the default/production branch).
- Change `sslmode=require` to **`sslmode=verify-full`** (keep `&channel_binding=require`). `env:check` accepts either; `verify-full` also checks the certificate.
- No string may contain the previously exposed password (compare against the old string you still have — never paste either one anywhere). If one does, Step 1 didn't apply to that branch.

## Automated setup (recommended): `npm run setup:env`
Replaces Steps 3–5 for the owner. Run it **yourself** in PowerShell or Git Bash — not through Claude Code (it refuses to write without an interactive terminal):
```powershell
cd D:\AnacondaProj\SchoolMang\SchoolMang
npm run setup:env -- --project-id <neon project id> --dry-run   # preview: no files opened, no secrets requested
npm run setup:env -- --project-id <neon project id>             # writes .env and .env.test
```
Security design (`scripts/setup-env.ts`, logic in `scripts/setup-env-lib.ts`, tests in `tests/unit/setup-env.test.ts`):
- Uses the signed-in Neon CLI. Finds the branches by name: production must be the **default** branch; `development` and `test` must be its children, each with exactly one read-write endpoint.
- Fetches four connection strings **into memory only** and checks each belongs to the branch it was requested for (endpoint id in the host, pooled vs direct); any production endpoint aborts the run. Forces `sslmode=verify-full`.
- Writes only these lines, in place (comments and all other lines preserved): `DATABASE_URL`, `DIRECT_URL`, `TEST_DATABASE_URL`, `FORBIDDEN_BRANCH_IDS` (= production branch), `FORBIDDEN_ENDPOINT_IDS` (= production endpoints), the four keys **only where empty** (never overwritten), `PRIVATE_STORAGE_LOCAL_DIR` (default `%USERPROFILE%\SchoolERP-files`, created; refused inside the project), and the seed account (prompted; password hidden). `.env.test` gets exactly the two test URLs.
- Refuses to replace database strings already present unless `--replace-urls`. Prints only ✓/✗ lines and ids — never values — and finishes with `npm run env:check:offline`.
- Never connects to PostgreSQL, runs SQL, resets passwords or changes branches. Never loads dotenv.
- Values that dotenv would misread (`#` starts a comment, leading/trailing spaces, quotes, `$`) are written **quoted**, and every written value is re-parsed with dotenv before saving — the run aborts if anything would read back differently.
- `npm run setup:env -- --seed-only` re-sets only `SEED_SUPERADMIN_USERNAME`/`SEED_SUPERADMIN_PASSWORD` (hidden prompt, app password rules); no Neon calls, `.env.test` untouched, every other variable verified unchanged.
- Afterwards: copy `DATA_ENCRYPTION_KEY` and `DOCUMENT_VERIFICATION_KEY` into your password manager.

## Step 4 — Create `.env` (you edit it; Claude Code cannot read it)
```powershell
Copy-Item .env.example .env
notepad .env
```
Fill in only these lines; leave everything else at its default:
```
DATABASE_URL=<development, pooled>
DIRECT_URL=<development, direct>
TEST_DATABASE_URL=<test, pooled>
APP_URL=http://localhost:3000
SESSION_SECRET=<key 1 from Step 5>
DATA_ENCRYPTION_KEY=<key 2 from Step 5>
DATA_HMAC_KEY=<key 3 from Step 5>
DOCUMENT_VERIFICATION_KEY=<key 4 from Step 5>
PRIVATE_STORAGE_LOCAL_DIR=<absolute folder OUTSIDE the project, e.g. C:\Users\<you>\SchoolERP-files>
SEED_SUPERADMIN_USERNAME=<lowercase admin username>
SEED_SUPERADMIN_PASSWORD=<10+ characters, not containing the username, not a common password>
```
- Notepad: **Save as type → All files** (otherwise it saves `.env.txt`), encoding UTF-8.
- Verify (prints names only, never contents):
  ```powershell
  Get-ChildItem -Force .env | Select-Object Name, Length
  git check-ignore -v .env
  ```
- The seeded Super Admin must change this password at first sign-in.
- Leave every other line exactly as copied from `.env.example` (empty lines are treated as "not set").

### Step 4b — Create `.env.test` (test-branch migrations only)
Create `D:\AnacondaProj\SchoolMang\SchoolMang\.env.test` the same way (Notepad, "All files"), containing **exactly**:
```
DATABASE_URL=<test branch, pooled>
DIRECT_URL=<test branch, direct>
```
- Git-ignored (`.env.*` rule) and on Claude Code's deny list.
- Selected only by `DOTENV_PATH=.env.test` (see Step 7). `env:check` and `db:seed` never use it; they read `.env`.
- Next.js treats `.env.test` as its `NODE_ENV=test` file; `npm run dev` / `npm run build` never use that mode, so it doesn't affect the app.

**Verified behaviour (2026-11-08, offline sandbox with fake URLs on closed local ports — no Neon):**

| Test | Result |
|---|---|
| dotenv 18.0.9 `config()` | merges `DOTENV_PATH` (fallback `DOTENV_CONFIG_PATH`) from the environment; loads **only** that file |
| `prisma migrate status` with `DOTENV_PATH=.env.test` | Prisma 7 CLI targeted the test marker — it does **not** load `.env` by itself (no hidden override) |
| `npm run db:check` with `DOTENV_PATH=.env.test` | both URLs = test marker |
| PowerShell `$env:DOTENV_PATH` | **persists** for every later command in the window until removed |
| `try { … } finally { Remove-Item Env:DOTENV_PATH }` | test target inside the block, development again afterwards |
| Typo in file name | fails safely ("Cannot resolve environment variable: DIRECT_URL") — no fallback to development |
| `DIRECT_URL` already set in the shell | **overrides** the file (dotenv never overrides existing variables) → hence the Step 7.0 check |

## Step 5 — Generate the four keys
Run **four times** (one per key) and paste each output into `.env`:
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
| Key | Used for | If lost |
|---|---|---|
| `SESSION_SECRET` | HMAC of IPs/visitor ids, rate-limit keys | counters reset — harmless |
| `DATA_ENCRYPTION_KEY` | AES-256-GCM encryption of Aadhaar/PAN/bank fields | **encrypted data becomes unreadable** — keep a copy in a password manager |
| `DATA_HMAC_KEY` | duplicate detection of sensitive values | duplicate checks stop matching older records |
| `DOCUMENT_VERIFICATION_KEY` | hashing document verification codes | issued documents can no longer be verified |

- All four must be different (`env:check` verifies this and their length). `DATA_ENCRYPTION_KEY_VERSION` and `DOCUMENT_VERIFICATION_KEY_VERSION` stay `1`.
- These are **development** keys. Production gets its own, set in the host's secret store at go-live.

## Step 5b — Offline check (no connection)
```powershell
npm run env:check:offline
```
Checks files and formats only — **never connects**: `.env` and `.env.test` exist; 8 required names; four keys valid and distinct; pooled/direct URLs on the same endpoint; test ≠ development; `.env.test` has exactly two URLs on the **test** endpoint (compared by fingerprints); `PRIVATE_STORAGE_LOCAL_DIR` absolute and outside the project. Must end with `ENV CHECK PASSED`. Claude Code may run this one for you.

## Step 6 — Run `env:check` and prove production is protected
```powershell
$env:FORBIDDEN_BRANCH_IDS = "<production branch id from Step 1>"
npm run env:check
```
`FORBIDDEN_BRANCH_IDS` **and** `FORBIDDEN_ENDPOINT_IDS` are **required**: without either the check refuses to connect. Forbidden endpoints are refused from the host name before any connection; forbidden branches after the read-only identity query. The check connects only if every other check passed. It loads `.env`, opens **read-only** sessions to development and test only, and prints **no values** (✓/✗ lines and 8-character branch fingerprints). It must end with `ENV CHECK PASSED`, having confirmed:
- 7 required variables present; keys valid and distinct;
- `DATABASE_URL` pooled and `DIRECT_URL` direct, on the **same** branch;
- the test branch differs from development;
- neither branch is in `FORBIDDEN_BRANCH_IDS`; no URL contains "prod"; SSL mode is require/verify-full.

**Prove the guard works (recommended):** use the *development* branch ID as forbidden — it **must fail** with "development branch is in FORBIDDEN_BRANCH_IDS — refusing" — then restore:
```powershell
$env:FORBIDDEN_BRANCH_IDS = "<development branch id>"; npm run env:check
$env:FORBIDDEN_BRANCH_IDS = "<production branch id>"
```
Protection layers: no production strings in `.env`; forbidden branch ID; "prod" URL rejection; read-only check sessions; owner approval before any migration or seed.

## Step 7 — Migration review checklist and commands
> **Superseded counts:** two migrations are now pending (Phase 1 `init` + Phase 2a). Use [PHASE_2A_DB_VERIFICATION_CHECKLIST.md](PHASE_2A_DB_VERIFICATION_CHECKLIST.md) for the order, gates and expected values (2 migrations, 16 tables, 80 permissions / 260 grants). The commands and safety rules below still apply.
Nothing in this step runs without explicit owner approval (naming the branch).

### Review (all must be ticked)
**Target**
- [ ] `env:check` passed in this PowerShell window with the production branch ID forbidden.
- [ ] Order: `development` first, then `test`. **Never production.**

**Content** of `prisma/migrations/20261108000000_init/migration.sql` (329 lines)
- [ ] 1 × `CREATE EXTENSION IF NOT EXISTS vector` (pgvector).
- [ ] 4 enum types, 15 tables, 26 indexes, 9 foreign keys.
- [ ] 0 `DROP`, 0 `TRUNCATE`, 0 `DELETE` — creates objects only.
- [ ] Same file validated by CI and by the earlier local throwaway database (migrated schema matched `schema.prisma`, no drift).

**Safety**
- [ ] Target branch is empty (new branch) or has a fresh Neon snapshot/restore point.
- [ ] `prisma migrate status` (read-only) shows exactly 1 pending migration **and the expected endpoint host** — both branches use the database name `neondb`, so the `ep-…` host is the only way to tell them apart; compare it with the endpoint on the branch's page in the Neon console.

**Never:** `prisma migrate reset`, `prisma db push`, editing an applied migration, or running anything with production strings loaded.

### 7.0 — Before **every** database command: no variables already set
Prints only True/False, never values:
```powershell
Test-Path Env:DATABASE_URL; Test-Path Env:DIRECT_URL; Test-Path Env:DOTENV_PATH
```
All three must print `False`. If any prints `True`, close the window and open a new one.

### 7.1 — Development branch (uses `.env`)
```powershell
npx prisma migrate status      # read-only: host must be the DEVELOPMENT endpoint (ep-…); 1 migration pending
npm run db:deploy
npm run db:check               # expect: pgvector enabled, 1/1 migrations, all 15 tables, size within budget
```

### 7.2 — Test branch (uses `.env.test`, **always** inside try/finally)
```powershell
try { $env:DOTENV_PATH = ".env.test"; npx prisma migrate status } finally { Remove-Item Env:DOTENV_PATH -ErrorAction SilentlyContinue }
# confirm the host is the TEST endpoint (ep-…, different from development); then:
try { $env:DOTENV_PATH = ".env.test"; npm run db:deploy; npm run db:check } finally { Remove-Item Env:DOTENV_PATH -ErrorAction SilentlyContinue }
Test-Path Env:DOTENV_PATH      # must print False
```
Do **not** use the form `$env:DOTENV_PATH=".env.test"; npm run db:deploy; …; Remove-Item …` — if interrupted, the variable stays set and later commands (e.g. the seed) would hit the test branch.

### 7.3 — Seed (development only; separate approval; never inside a DOTENV_PATH block)
The seed guards itself (ADR-032): it refuses if `DOTENV_PATH`, `DOTENV_CONFIG_PATH` or any database URL is set in the shell, reads only `.env`, and writes only if `DATABASE_URL` and the server's own branch/endpoint match `SEED_TARGET_BRANCH_ID`/`SEED_TARGET_ENDPOINT_ID` (not forbidden, not test). Everything happens in one transaction; any problem rolls it back. Use `npm run db:seed` — not `npx prisma db seed` (that pre-loads `.env` into the environment, which the guard refuses).
```powershell
Test-Path Env:DOTENV_PATH      # must print False
npm run db:seed                # expect: 80 permissions, 13 roles, 260 role grants, Super Admin created
```

### 7.4 — Record
Add the results (commands run, pass/fail, counts — never values) to docs/DEVELOPMENT_PROGRESS.md.

## After this guide
Remaining Phase 1 database work (DEVELOPMENT_PROGRESS.md → "Remaining Phase 1 database tasks"): 20 integration tests on `test`, 33 database e2e tests, Super Admin sign-in and ERP UI audit, `pg_dump` restore drill and point-in-time restore test, least-privilege audit-log role.
