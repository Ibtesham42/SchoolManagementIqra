---
name: documentation-management
description: Use at the end of every task or phase to update project documentation accurately — which documents to touch for which change, how to record test evidence, and how to keep historical records. Used by the documentation-manager agent and by anyone finishing a task.
---

# Documentation management

## What to update when
| Change | Update |
|---|---|
| Any completed task | docs/DEVELOPMENT_PROGRESS.md (dated entry: what, evidence, pending), docs/CHANGELOG.md (Unreleased) |
| New/changed endpoint or server action | docs/API_DOCUMENTATION.md (implemented section only) |
| New permission / role change | catalog → `npm run rbac:matrix`; docs/AUTHENTICATION_AND_RBAC.md if rules change |
| Schema change | docs/DATABASE_SCHEMA.md, DATABASE_RELATIONSHIPS.md |
| Architectural decision | ADR row in docs/SYSTEM_ARCHITECTURE.md §2 |
| Security finding / control | docs/SECURITY.md (with ID), KNOWN_ISSUES if not fixed |
| New env var | docs/ENVIRONMENT_VARIABLES.md (+ `.env.example`, names only) |
| UI audit | docs/LOCAL_UI_AUDIT.md |
| Phase status change | docs/DEVELOPMENT_ROADMAP.md (status + completion criteria evidence) |
| New command/workflow rule | CLAUDE.md, README.md, the relevant `.claude/rules` file |

## Evidence rules
- Write results as numbers with the command that produced them (e.g. "`npm run test:unit`: 1,263 passed"). Distinguish **passed / failed / skipped (pending, reason) / not run**.
- Never record a database-dependent test as passed without a run against the Neon `test` branch.
- Say where verification happened (local Windows, CI Ubuntu, offline server without DB).

## History rules
- Add new dated sections; don't rewrite past entries. Resolved KNOWN_ISSUES keep their row with "Resolved <date>: how". IDs are never reused.
- Superseded documents get a pointer at the top (e.g. PROJECT_PLAN → DEVELOPMENT_ROADMAP), not deletion.

## Never
Secrets, connection strings, keys, real personal data, or claims not backed by observed output.
