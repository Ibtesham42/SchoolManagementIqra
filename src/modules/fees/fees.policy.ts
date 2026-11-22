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
  return canReadFees(ctx) || (hasPermission(ctx, "fee.structure.manage") && scopeFor(ctx, "fee.structure.manage") === "ALL");
}

export function assertFeeSetupRead(ctx: AuthContext): void {
  if (!canReadFeeSetup(ctx)) throw new ForbiddenError();
}

/**
 * Review 5A-M3 M1: fee WRITE rights count only at ALL scope — a custom role given a fee write permission at CHILDREN /
 * SELF / ASSIGNED must not get whole-school power (no scoped fee writes exist yet). Same idea as marks.approve.
 */
export type FeeWritePermission = "fee.structure.manage" | "fee.concession.manage" | "fee.concession.approve" | "fee.collect" | "fee.refund";
export const holdsAll = (ctx: AuthContext, key: FeeWritePermission) => hasPermission(ctx, key) && scopeFor(ctx, key) === "ALL";
export function authorizeFeeWrite(ctx: AuthContext, key: FeeWritePermission): void {
  if (!holdsAll(ctx, key)) throw new ForbiddenError();
}

export const canManageFeeSetup = (ctx: AuthContext) => holdsAll(ctx, "fee.structure.manage");

/**
 * Phase 5B-M3: receipts are read by fee readers, collectors and cancellers (the Principal holds `fee.refund` but not
 * `fee.read`), all at ALL scope.
 */
export const canReadReceipts = (ctx: AuthContext) => canReadFees(ctx) || holdsAll(ctx, "fee.collect") || holdsAll(ctx, "fee.refund");
export function assertReceiptRead(ctx: AuthContext): void {
  if (!canReadReceipts(ctx)) throw new ForbiddenError();
}

/** Phase 5C (FC20): fee reports at `fee.report` ALL (Accountant, Principal, Vice Principal, Super Admin). */
export const canReadFeeReports = (ctx: AuthContext) => hasPermission(ctx, "fee.report") && scopeFor(ctx, "fee.report") === "ALL";
export function assertFeeReports(ctx: AuthContext): void {
  if (!canReadFeeReports(ctx)) throw new ForbiddenError();
}

export type ReceiptCancelRefusal = "NOT_PERMITTED" | "ALREADY_CANCELLED" | "OWN_COLLECTION" | "COLLECTOR_UNKNOWN" | "NOT_SAME_DAY" | "SESSION_CLOSED";

export interface ReceiptCancelFacts {
  status: "SUCCESS" | "CANCELLED";
  collectedById: string | null;
  /** The receipt was recorded today (school time zone). */
  recordedToday: boolean;
  /** The receipt paid an invoice of a CLOSED academic session. */
  closedSession: boolean;
}

/**
 * FC13 + review 5A L5 + review 5B-M3 M2 (owner decision 2026-11-22): who may cancel a receipt. Returns null when allowed.
 * - `fee.refund` at ALL; never the collector (two people — also a database CHECK); a receipt whose collector is no
 *   longer a user only by a Super Admin.
 * - A canceller who can also COLLECT (the Accountant: a peer of the collector) cancels only receipts recorded TODAY;
 *   older receipts need a canceller who doesn't collect (the Principal) or a Super Admin — so two Accountants can't
 *   quietly cancel a genuine receipt from an earlier day.
 * - A receipt that paid a CLOSED session's invoice: Super Admin only.
 */
export function receiptCancelRefusal(ctx: AuthContext, p: ReceiptCancelFacts): ReceiptCancelRefusal | null {
  if (!holdsAll(ctx, "fee.refund")) return "NOT_PERMITTED";
  if (p.status === "CANCELLED") return "ALREADY_CANCELLED";
  if (p.collectedById === ctx.userId) return "OWN_COLLECTION";
  if (ctx.isSuperAdmin) return null;
  if (p.collectedById === null) return "COLLECTOR_UNKNOWN";
  if (p.closedSession) return "SESSION_CLOSED";
  if (hasPermission(ctx, "fee.collect") && !p.recordedToday) return "NOT_SAME_DAY";
  return null;
}

/** What the Fees area shows (cosmetic; every service checks again). */
export function feeAccess(ctx: AuthContext) {
  return {
    any: canReadFeeSetup(ctx) || canReadReceipts(ctx) || hasPermission(ctx, "fee.collect") || hasPermission(ctx, "fee.concession.manage") || hasPermission(ctx, "fee.concession.approve") || (hasPermission(ctx, "fee.report") && scopeFor(ctx, "fee.report") === "ALL"),
    setup: canReadFeeSetup(ctx),
    manageSetup: canManageFeeSetup(ctx),
    concessions: canReadFees(ctx) || holdsAll(ctx, "fee.concession.manage") || holdsAll(ctx, "fee.concession.approve"),
    proposeConcessions: holdsAll(ctx, "fee.concession.manage"),
    approveConcessions: holdsAll(ctx, "fee.concession.approve"),
    receipts: canReadReceipts(ctx),
  };
}
