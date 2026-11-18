---
name: auth-rbac
description: Use when adding or changing permissions, roles, scopes, record-level policies, user/role administration, sessions, login, password change/reset, or any authorization check. Explains the permission catalog workflow and the project's anti-escalation and Super Admin rules.
---

# Authentication & RBAC

Source of truth: `src/lib/rbac/catalog.ts` (permissions + default role grants), `src/lib/rbac/authorize.ts`, `src/modules/identity/identity.policy.ts`. Design doc: docs/AUTHENTICATION_AND_RBAC.md (§2a = administration rules).

## Adding a permission (every new module needs this)
1. Add `"module.action": "Description"` to `PERMISSIONS` in `catalog.ts`; grant it to default roles in `ROLES` (scopes: `ALL`, `ASSIGNED`, `SELF`, `CHILDREN`).
2. `npm run rbac:matrix` → regenerates `docs/RBAC_MATRIX.md` (a unit test fails if it's stale).
3. Update the counts asserted in `tests/unit/rbac-matrix.test.ts` and add the permission to the sensitive matrix in `tests/unit/rbac.test.ts` if it guards sensitive data.
4. Seeding adds new permissions; existing *edited* role grants are not overwritten (Super Admin always gets everything).
5. In the service: `const scope = authorize(ctx, "module.action")`, then narrow records by scope in the module's `*.policy.ts`.

## Rules that must never be weakened
- Authorization is server-side in services; `hasPermission` in pages/nav is presentation only.
- A pending forced password change blocks every permissioned operation (`authorize` throws).
- Scope coverage is a partial order (`scopeCovers`): ALL ⊇ all; X ⊇ X; any ⊇ SELF; ASSIGNED and CHILDREN don't cover each other.
- Delegated (non–Super Admin) administrators: only assign roles / grant permissions they hold (`actorCovers`, `assertGrantsWithinActor`); only modify users whose **entire** permission set they hold (`assertCanModifyUser`); can't edit a role they hold.
- Super Admin role is immutable; only a Super Admin modifies Super Admins; ≥ 1 active Super Admin always — any transaction that can change Super Admin membership calls `lockSuperAdminGuard(tx)` first.
- Parents: CHILDREN only. Students: SELF only. Neither holds write permissions (tested invariants).

## Sessions & credentials
DB sessions (SHA-256 token hashes), `__Host-sid` over HTTPS, 8 h idle / 30-day absolute (`nextSessionExpiry`), revoke on deactivate/password change/reset. Argon2id hashing outside transactions. Reset tokens: single-use, 30 min, URL fragment, no enumeration.

## Tests required for any change here
Unit: policy cases incl. delegation and scope order. Integration (Neon `test`): permissions loaded through real sessions, forbidden roles get Forbidden, concurrency for Super Admin changes. E2E: forced-change bypass attempts, not-permitted screens.
