import type { Tx } from "@/lib/db";
import { SUPER_ADMIN } from "./identity.policy";

/**
 * Serializes every operation that can change who is an active Super Admin (ADR-025, rule 17).
 * A transaction-scoped advisory lock (released at commit/rollback; works through Neon's
 * transaction-mode pooler). Row locks on a JOIN are NOT enough under READ COMMITTED: a blocked
 * `SELECT … FOR UPDATE` re-checks only the locked rows, while joined rows (user_role) come from the
 * old snapshot — so "remove A's role" racing "deactivate B" could leave zero Super Admins.
 * Must be the FIRST statement of the transaction, before any reads it depends on.
 *
 * Shared by users.service (admin operations) and prisma/seed-core (initial Super Admin) so there is
 * exactly one implementation.
 */
export async function lockSuperAdminGuard(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('school_erp.super_admin_guard'))) AS l`;
}

/** Read AFTER lockSuperAdminGuard(): each READ COMMITTED statement sees all prior commits. */
export async function activeSuperAdminIds(tx: Tx): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT u.id FROM "user" u
    JOIN user_role ur ON ur.user_id = u.id
    JOIN role r ON r.id = ur.role_id
    WHERE r.key = ${SUPER_ADMIN} AND u.is_active AND u.deleted_at IS NULL`;
  return rows.map((r) => r.id);
}
