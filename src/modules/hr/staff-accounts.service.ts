import { prisma, type Tx } from "@/lib/db";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { authorize, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { employeeHasAccountTx, getLinkedAccount, linkEmployeeAccountTx, listLinkableAccounts, unlinkEmployeeAccountTx } from "@/modules/identity/users.service";
import { employeeReadAccess } from "./hr.policy";
import type { LinkAccountInput } from "./hr.schemas";

/**
 * Linking a staff record to a login account (Phase 3A M3, owner decision H2): optional, one account per
 * employee, needs `employee.manage` AND `user.manage` (Q2: HR Manager alone can't), audited by the identity
 * service, never automatic. Lock order: employee FOR UPDATE (here) → user FOR UPDATE (identity helper).
 *
 * Linking gives the account nothing by itself in M3a: "My profile" (SELF scope) and the class-teacher rule
 * (H4) use the link only after their separate owner approval.
 */
export function canLinkAccounts(ctx: AuthContext): boolean {
  return hasPermission(ctx, "employee.manage") && hasPermission(ctx, "user.manage");
}

function authorizeLink(ctx: AuthContext) {
  authorize(ctx, "employee.manage");
  authorize(ctx, "user.manage");
  employeeReadAccess(ctx);
}

async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM employee WHERE id = ${employeeId} AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Employee not found.");
}

const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

export async function linkStaffAccount(ctx: AuthContext, input: LinkAccountInput): Promise<{ username: string }> {
  authorizeLink(ctx);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, input.employeeId);
      if (await employeeHasAccountTx(tx, input.employeeId)) throw new ConflictError("This employee already has a login account. Unlink it first.");
      return linkEmployeeAccountTx(tx, ctx, input.userId, input.employeeId);
    });
  } catch (e) {
    return busy(e);
  }
}

export async function unlinkStaffAccount(ctx: AuthContext, employeeId: string): Promise<void> {
  authorizeLink(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      await unlinkEmployeeAccountTx(tx, ctx, employeeId);
    });
  } catch (e) {
    busy(e);
  }
}

/** The "Login account" panel: the linked account (needs `user.read`) and, for linkers, the accounts available. */
export async function staffAccountPanel(ctx: AuthContext, employeeId: string) {
  employeeReadAccess(ctx);
  if (!hasPermission(ctx, "user.read")) return null;
  const [linked, candidates] = await Promise.all([getLinkedAccount(ctx, employeeId), canLinkAccounts(ctx) ? listLinkableAccounts(ctx) : Promise.resolve([])]);
  return { linked, candidates, canLink: canLinkAccounts(ctx) };
}
