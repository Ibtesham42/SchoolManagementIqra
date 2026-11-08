import type { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { maskEmail, sendEmail } from "@/lib/email";
import { ValidationError } from "@/lib/errors";
import { RULES, enforce } from "@/lib/rate-limit";
import type { passwordResetCompleteSchema, passwordResetRequestSchema } from "./identity.schemas";

export const RESET_TOKEN_TTL_MINUTES = 30;

/** Pure: a token row is usable only if unused and unexpired. */
export function isResetTokenUsable(row: { usedAt: Date | null; expiresAt: Date } | null, now = new Date()): boolean {
  return !!row && row.usedAt === null && row.expiresAt.getTime() > now.getTime();
}

/**
 * The token travels in the URL FRAGMENT (`#token=…`). Browsers never send fragments to the server,
 * so the token can't appear in reverse-proxy/host access logs, analytics or Referer headers.
 * The reset page reads it client-side, strips it from the address bar and POSTs it in the body.
 */
export function resetLink(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/reset-password#token=${encodeURIComponent(token)}`;
}

/** Synchronous part of a reset request: rate limits (may throw RateLimitedError). */
export async function enforceResetRequestLimits(input: z.infer<typeof passwordResetRequestSchema>, meta: { ipHash: string }) {
  await enforce(RULES.passwordReset, `ip:${meta.ipHash}`);
  await enforce(RULES.passwordReset, `id:${input.identifier}`);
}

/**
 * Convenience for scripts/tests: limits + processing in one call.
 * The web action calls enforceResetRequestLimits() and defers processResetRequest() until after
 * the response is sent, so response time doesn't reveal whether the account exists.
 */
export async function requestPasswordReset(input: z.infer<typeof passwordResetRequestSchema>, meta: { ipHash: string }) {
  await enforceResetRequestLimits(input, meta);
  await processResetRequest(input, meta);
}

/**
 * A link is emailed only when the identifier matches an active account that has an email address.
 * Accounts without email are reset by an administrator (Users → Reset password).
 */
export async function processResetRequest(input: z.infer<typeof passwordResetRequestSchema>, meta: { ipHash: string }) {
  const user = await prisma.user.findFirst({
    where: { deletedAt: null, isActive: true, OR: [{ username: input.identifier }, { email: input.identifier }] },
    select: { id: true, email: true, displayName: true },
  });
  if (!user?.email) return;

  const token = randomToken(32);
  await prisma.$transaction(async (tx) => {
    // Only the newest link works.
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000) },
    });
    await audit(tx, { userId: null, ipHash: meta.ipHash }, { action: "auth.password_reset_requested", entityType: "User", entityId: user.id, after: { to: maskEmail(user.email!) } });
  });

  const link = resetLink(process.env.APP_URL ?? "", token);
  try {
    await sendEmail({
      to: user.email,
      kind: "password_reset",
      subject: "Reset your password",
      text: [
        `Hello ${user.displayName},`,
        "",
        `Use this link within ${RESET_TOKEN_TTL_MINUTES} minutes to set a new password:`,
        link,
        "",
        "If you did not ask for this, you can ignore this email — your password will not change.",
      ].join("\n"),
    });
  } catch (e) {
    // Never reveal delivery problems to the requester (enumeration); record for administrators.
    console.error("password reset email failed", e instanceof Error ? e.name : "unknown");
  }
}

/** Validates a token without consuming it (for rendering the reset form). */
export async function checkResetToken(token: string): Promise<boolean> {
  if (!token || token.length > 100) return false;
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256Hex(token) }, select: { usedAt: true, expiresAt: true } });
  return isResetTokenUsable(row);
}

export async function completePasswordReset(input: z.infer<typeof passwordResetCompleteSchema>, meta: { ipHash: string }) {
  await enforce(RULES.passwordReset, `ip:${meta.ipHash}`);
  if (input.newPassword !== input.confirmPassword) {
    throw new ValidationError("Passwords do not match.", [{ path: "confirmPassword", message: "Passwords do not match." }]);
  }
  const invalid = new ValidationError("This reset link is invalid or has expired. Please request a new one.");
  const tokenHash = sha256Hex(input.token);

  // Pre-check outside the transaction so the slow Argon2 hash isn't computed while holding a row lock.
  const pre = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { usedAt: true, expiresAt: true, user: { select: { id: true, username: true, isActive: true, deletedAt: true } } },
  });
  if (!pre || !isResetTokenUsable(pre) || !pre.user.isActive || pre.user.deletedAt) throw invalid;
  const problem = passwordProblem(input.newPassword, pre.user.username);
  if (problem) throw new ValidationError(problem, [{ path: "newPassword", message: problem }]);
  const passwordHash = await hashPassword(input.newPassword);

  await prisma.$transaction(async (tx) => {
    // Re-verify under lock: exactly one concurrent completion can consume the token.
    const rows = await tx.$queryRaw<{ user_id: string; used_at: Date | null; expires_at: Date }[]>`
      SELECT user_id, used_at, expires_at FROM password_reset_token WHERE token_hash = ${tokenHash} FOR UPDATE`;
    const row = rows[0];
    if (!row || row.user_id !== pre.user.id || !isResetTokenUsable({ usedAt: row.used_at, expiresAt: row.expires_at })) throw invalid;
    const user = { id: row.user_id };

    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        passwordChangedAt: new Date(),
      },
    });
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await audit(tx, { userId: user.id, ipHash: meta.ipHash }, { action: "auth.password_reset_completed", entityType: "User", entityId: user.id });
  });
}
