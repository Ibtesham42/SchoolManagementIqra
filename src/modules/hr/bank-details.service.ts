import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { decryptField, encryptField, lookupHash } from "@/lib/crypto";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { maskEnd, type UpdateBankDetailsInput } from "./bank-details.schemas";
import { assertActorLinked, isOwnRecord } from "./hr.policy";

/**
 * Phase 3C (P8) — an employee's PAN and bank details (CLAUDE.md rule 10, ADR-037).
 *
 * - Stored encrypted (`lib/crypto`, AES-256-GCM, key-versioned) with an HMAC for dedupe (PAN unique across staff).
 * - Read: `employee.sensitive.read` (HR Manager, Super Admin) — and only MASKED values leave this service.
 * - Change: `employee.sensitive.read` + `employee.manage`; linked actor; never one's own record (Super Admin included).
 * - Never logged; audit rows say which parts changed, never the values; errors never echo them.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });

function safeMask(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return maskEnd(decryptField(enc));
  } catch {
    return "(unreadable — re-enter)"; // wrong key version etc.; never the ciphertext
  }
}

export async function getBankDetails(ctx: AuthContext, employeeId: string) {
  authorize(ctx, "employee.sensitive.read");
  const e = await prisma.employee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { id: true, version: true, panEnc: true, bankAccountEnc: true, bankAccountHmac: true, bankIfsc: true, bankAccountName: true },
  });
  if (!e) throw new NotFoundError("Employee not found.");
  const sharedWith = e.bankAccountHmac ? await prisma.employee.count({ where: { bankAccountHmac: e.bankAccountHmac, deletedAt: null, id: { not: e.id } } }) : 0;
  return {
    version: e.version,
    pan: safeMask(e.panEnc),
    bankAccount: safeMask(e.bankAccountEnc),
    bankIfsc: e.bankIfsc,
    bankAccountName: e.bankAccountName,
    sharedWith,
    own: isOwnRecord(ctx, employeeId),
  };
}

export async function updateBankDetails(ctx: AuthContext, input: UpdateBankDetailsInput) {
  authorize(ctx, "employee.sensitive.read");
  authorize(ctx, "employee.manage");
  assertActorLinked(ctx);
  if (isOwnRecord(ctx, input.employeeId)) throw new ForbiddenError("You can't change your own PAN or bank details. Someone else must do it.");
  // CPU work (encryption) before the transaction.
  const pan = input.pan ? { panEnc: encryptField(input.pan), panHmac: lookupHash(input.pan) } : null;
  const bank = input.bankAccount ? { bankAccountEnc: encryptField(input.bankAccount), bankAccountHmac: lookupHash(input.bankAccount) } : null;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
      const [row] = await tx.$queryRaw<{ version: number; has_account: boolean; bank_ifsc: string | null; bank_account_name: string | null }[]>`
        SELECT version, bank_account_enc IS NOT NULL AS has_account, bank_ifsc, bank_account_name
        FROM employee WHERE id = ${input.employeeId} AND deleted_at IS NULL FOR UPDATE`;
      if (!row) throw new NotFoundError("Employee not found.");
      if (row.version !== input.version) throw new ConflictError("This staff record was changed by someone else. Reload the page and try again.");
      const data: Record<string, string | null> = {};
      if (pan) Object.assign(data, pan);
      if (input.removePan) Object.assign(data, { panEnc: null, panHmac: null });
      if (bank) Object.assign(data, bank);
      if (input.bankIfsc) data.bankIfsc = input.bankIfsc;
      if (input.bankAccountName) data.bankAccountName = input.bankAccountName;
      if (input.removeBank) Object.assign(data, { bankAccountEnc: null, bankAccountHmac: null, bankIfsc: null, bankAccountName: null });
      if (Object.keys(data).length === 0) return;
      // Review P8 L1: after the change, bank details are complete (account + IFSC + name) or absent.
      const hasAccount = "bankAccountEnc" in data ? data.bankAccountEnc !== null : row.has_account;
      const ifsc = "bankIfsc" in data ? data.bankIfsc : row.bank_ifsc;
      const name = "bankAccountName" in data ? data.bankAccountName : row.bank_account_name;
      if ([hasAccount, ifsc !== null, name !== null].some((x) => x !== hasAccount)) {
        throw new ValidationError("Bank details must be complete: account number, IFSC and the name on the account (or remove them all).", [
          { path: "bankAccount", message: "Incomplete bank details." },
        ]);
      }
      // Review P8 L2: the same account on another active staff record (ghost-employee risk) is allowed (joint accounts) but flagged.
      const sharedWith = bank ? await tx.employee.count({ where: { bankAccountHmac: bank.bankAccountHmac, deletedAt: null, id: { not: input.employeeId } } }) : 0;
      await tx.employee.update({ where: { id: input.employeeId }, data: { ...data, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), {
        action: "employee.bank_details_update",
        entityType: "Employee",
        entityId: input.employeeId,
        after: {
          panChanged: Boolean(pan) || input.removePan,
          bankAccountChanged: Boolean(bank) || input.removeBank,
          ifscChanged: Boolean(input.bankIfsc) || input.removeBank,
          accountNameChanged: Boolean(input.bankAccountName) || input.removeBank,
          sharedAccount: sharedWith > 0,
        },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e, "panHmac")) throw new ConflictError("This PAN is already recorded for another employee.");
    if (isTransactionBusy(e)) throw new ServiceBusyError();
    throw e;
  }
}
