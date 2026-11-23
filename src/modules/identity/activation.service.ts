import { timingSafeEqual } from "node:crypto";
import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { MAX_ACTIVATION_ATTEMPTS, hashActivationCode, isActivationUsable, normalizeActivationCode } from "@/lib/auth/activation-code";
import { AppError, ValidationError } from "@/lib/errors";
import { accountKindOf } from "@/lib/rbac/account-kind";
import { RULES, enforce } from "@/lib/rate-limit";
import type { ActivateAccountInput } from "./activation.schemas";
import { clearLoginLimits } from "./auth.service";

/**
 * Phase 6A-M3 (ADR-046) — a parent (later a student) opens the account the office issued: username + activation
 * code + the child's date of birth (second knowledge check), privacy consent (DPDP), own password.
 *
 * - ONE message for an unknown username, a wrong / expired / superseded / used code, a date-of-birth mismatch and a
 *   deactivated account (no enumeration).
 * - Rate limits per IP and per username BEFORE any account lookup. A wrong date of birth with the RIGHT code counts on
 *   that code, which becomes void at MAX_ACTIVATION_ATTEMPTS (the office prints a new slip); a wrong code counts
 *   nowhere (review M1 — no lock-out of a real parent by someone who only knows the mobile number).
 * - Argon2 runs before the transaction, for every well-formed request (no timing difference); the state is
 *   re-checked under lock: user FOR UPDATE → activation FOR UPDATE (lock order §2.6). Two concurrent activations →
 *   exactly one wins.
 * - The session is created only after the password is set; every older session and code ends.
 * - Identity knows no student data: the caller passes `datesOfBirth` (the students module reads the linked children).
 */
export class ActivationFailedError extends AppError {
  constructor() {
    super("VALIDATION_FAILED", "These details don't match. Check the username, the activation code and the date of birth, or ask the school office for a new slip.");
  }
}

export interface ActivationDeps {
  /** School-local dates of birth (YYYY-MM-DD) that prove this account: the guardian's children it can see, or the student's own. */
  datesOfBirth: (tx: Tx, person: { guardianId: string | null; studentId: string | null }) => Promise<string[]>;
  /** The privacy-notice version the account holder consents to (school setting). */
  consentVersion: string;
}

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

type Outcome = { ok: true; userId: string; username: string } | { ok: false };

/**
 * Review 6A-M3a L3: an unknown or ineligible username runs the same kind of reads as a known one (the code row and
 * a family lookup, for no rows), so response time says little about which mobile numbers hold an account.
 */
async function equalizedFailure(tx: Tx): Promise<Outcome> {
  await tx.$queryRaw`SELECT id FROM account_activation WHERE user_id = ${"-"} AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  await tx.studentGuardian.findMany({ where: { guardianId: "-" }, take: 1, select: { studentId: true } });
  await tx.user.findFirst({ where: { id: "-" }, select: { id: true } });
  return { ok: false };
}

export async function activatePortalAccount(input: ActivateAccountInput, meta: { ipHash: string; userAgent?: string }, deps: ActivationDeps) {
  await enforce(RULES.activationPerIp, meta.ipHash);
  // Review 6A-M3a L2: the parent's own password typos touch no data and don't use up the per-username bucket.
  if (input.newPassword !== input.confirmPassword) throw new ValidationError("Passwords do not match.", [{ path: "confirmPassword", message: "Passwords do not match." }]);
  const problem = passwordProblem(input.newPassword, input.username);
  if (problem) throw new ValidationError(problem, [{ path: "newPassword", message: problem }]);
  await enforce(RULES.activationPerUser, input.username);

  const code = normalizeActivationCode(input.code);
  const passwordHash = await hashPassword(input.newPassword); // always, before any lookup (timing)
  if (!code) throw new ActivationFailedError();
  const codeHash = hashActivationCode(code);

  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    const users = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "user" WHERE username = ${input.username} AND deleted_at IS NULL FOR UPDATE`;
    if (users.length === 0) return equalizedFailure(tx);
    const user = await tx.user.findUniqueOrThrow({
      where: { id: users[0].id },
      select: { id: true, username: true, isActive: true, guardianId: true, studentId: true, employeeId: true, roles: { select: { role: { select: { key: true } } } } },
    });
    const kind = accountKindOf(user.roles.map((r) => r.role.key));
    if (!user.isActive || kind === "STAFF" || user.employeeId || (!user.guardianId && !user.studentId)) return equalizedFailure(tx);

    const live = await tx.$queryRaw<{ id: string; code_hash: string; used_at: Date | null; expires_at: Date; failed_attempts: number }[]>`
      SELECT id, code_hash, used_at, expires_at, failed_attempts FROM account_activation
      WHERE user_id = ${user.id} AND used_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
    const row = live[0];
    if (!row || !isActivationUsable({ usedAt: row.used_at, expiresAt: row.expires_at })) return { ok: false };

    const dobs = await deps.datesOfBirth(tx, { guardianId: user.guardianId, studentId: user.studentId });
    // Review 6A-M3a M1: a WRONG CODE never counts against the code — otherwise anyone who knows a parent's mobile
    // number could void their slip with junk. Guessing the ~59-bit code is bounded by the per-IP limit. Only the
    // holder of the right code who gets the date of birth wrong uses up attempts (the slip-holder DOB guess).
    if (!sameHash(row.code_hash, codeHash)) return { ok: false };
    if (!dobs.includes(input.dob)) {
      const failed = row.failed_attempts + 1;
      await tx.accountActivation.update({ where: { id: row.id }, data: { failedAttempts: failed, ...(failed >= MAX_ACTIVATION_ATTEMPTS ? { usedAt: new Date() } : {}) } });
      if (failed >= MAX_ACTIVATION_ATTEMPTS) await audit(tx, { userId: null, ipHash: meta.ipHash }, { action: "portal.code_locked", entityType: "User", entityId: user.id });
      return { ok: false };
    }

    const now = new Date();
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: now, privacyConsentAt: now, privacyConsentVersion: deps.consentVersion.slice(0, 20) },
    });
    await tx.accountActivation.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    await audit(tx, { userId: user.id, ipHash: meta.ipHash }, { action: "portal.account_activated", entityType: "User", entityId: user.id, after: { consentVersion: deps.consentVersion.slice(0, 20) } });
    return { ok: true, userId: user.id, username: user.username };
  });

  if (!outcome.ok) throw new ActivationFailedError();
  await clearLoginLimits(outcome.username);
  // A fresh session after activation (never a pre-auth one); "keep me signed in" is chosen at the next login.
  return createSession(outcome.userId, { long: false, ipHash: meta.ipHash, userAgent: meta.userAgent });
}
