import { ForbiddenError } from "@/lib/errors";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";

/**
 * Phase 5 fee access rules (PHASE_5_PLAN.md §4, FC17). Pure — unit tested.
 * - Fee data is read at `fee.read` ALL (or by holders of a fee write permission for the part they write).
 * - CHILDREN (Parent) and SELF (Student) are REFUSED until Phase 6 adds the guardian / student link — never guessed
 *   (same principle as students.policy). ASSIGNED isn't granted to anyone for fees and is refused as well.
 */
export function canReadFees(ctx: AuthContext): boolean {
  return hasPermission(ctx, "fee.read") && scopeFor(ctx, "fee.read") === "ALL";
}

export function assertFeeRead(ctx: AuthContext): void {
  if (!canReadFees(ctx)) throw new ForbiddenError();
}

/** Setup screens: readers at ALL, or the setup manager. */
export function canReadFeeSetup(ctx: AuthContext): boolean {
  return canReadFees(ctx) || hasPermission(ctx, "fee.structure.manage");
}

export function assertFeeSetupRead(ctx: AuthContext): void {
  if (!canReadFeeSetup(ctx)) throw new ForbiddenError();
}

export const canManageFeeSetup = (ctx: AuthContext) => hasPermission(ctx, "fee.structure.manage");

/** What the Fees area shows (cosmetic; every service checks again). */
export function feeAccess(ctx: AuthContext) {
  return {
    any: canReadFeeSetup(ctx) || hasPermission(ctx, "fee.collect") || hasPermission(ctx, "fee.concession.manage") || hasPermission(ctx, "fee.concession.approve") || (hasPermission(ctx, "fee.report") && scopeFor(ctx, "fee.report") === "ALL"),
    setup: canReadFeeSetup(ctx),
    manageSetup: canManageFeeSetup(ctx),
  };
}
