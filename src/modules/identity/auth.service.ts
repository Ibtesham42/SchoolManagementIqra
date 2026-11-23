import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { burnPasswordCheck, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { isUsablePasswordHash } from "@/lib/auth/activation-code";
import { RULES, assertBelowLimit, enforce, hit, resetSubject } from "@/lib/rate-limit";
import { AppError } from "@/lib/errors";
import { accountKindOf, homePathFor, longSessionAllowed } from "@/lib/rbac/account-kind";

export const loginSchema = z
  .object({
    username: z.string().trim().toLowerCase().min(1).max(100),
    password: z.string().min(1).max(128),
    remember: z.boolean().default(false),
  })
  .strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

/** Same message for unknown user, wrong password and locked account (no account enumeration). */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super("UNAUTHENTICATED", "Invalid username or password.");
  }
}

/**
 * Rate limits (S-03): per IP and per (username, IP) count every attempt; the per-username ceiling counts only
 * FAILED attempts and is checked before any work. So an attacker can't keep a user out from another address
 * by spending a shared bucket, while distributed guessing stays bounded — and the account lock after
 * MAX_FAILED_ATTEMPTS failures remains the primary brute-force control. Every failure path records a failure
 * (unknown, inactive, locked, wrong password), so they also cost the same extra round trip.
 */
export async function login(input: LoginInput, meta: { ipHash: string; userAgent?: string }) {
  await enforce(RULES.loginPerIp, meta.ipHash);
  await enforce(RULES.loginPerUserIp, input.username, meta.ipHash);
  await assertBelowLimit(RULES.loginFailuresPerUser, input.username);
  const fail = async (): Promise<never> => {
    await hit(RULES.loginFailuresPerUser, input.username);
    throw new InvalidCredentialsError();
  };

  const user = await prisma.user.findUnique({
    where: { username: input.username },
    include: { roles: { include: { role: { select: { key: true } } } } },
  });

  if (!user || !user.isActive || user.deletedAt) {
    await burnPasswordCheck(input.password);
    return fail();
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await burnPasswordCheck(input.password);
    return fail();
  }

  // Phase 6A-M3: a portal account not activated yet (or reset by the office) has no usable password — it costs the
  // same Argon2 work as a wrong password, so timing doesn't tell "awaiting activation" apart.
  if (!isUsablePasswordHash(user.passwordHash)) await burnPasswordCheck(input.password);
  const ok = isUsablePasswordHash(user.passwordHash) && (await verifyPassword(user.passwordHash, input.password));
  // Review 6A-M3a M2: a portal account without recorded consent (never activated) can't sign in, even with a password.
  const roleKeysAll = user.roles.map((r) => r.role.key);
  if (ok && accountKindOf(roleKeysAll) !== "STAFF" && !user.privacyConsentAt) return fail();
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_ATTEMPTS;
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : undefined,
        },
      });
      if (lock) {
        await audit(tx, { userId: null, ipHash: meta.ipHash }, { action: "auth.locked", entityType: "User", entityId: user.id });
      }
    });
    return fail();
  }

  // ADR-045: only a portal-only account (exactly PARENT or STUDENT) may keep a 30-day session; staff get 8 h.
  const roleKeys = user.roles.map((r) => r.role.key);
  const long = longSessionAllowed(roleKeys, input.remember);
  const session = await createSession(user.id, { long, ipHash: meta.ipHash, userAgent: meta.userAgent });
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await audit(tx, { userId: user.id, ipHash: meta.ipHash }, { action: "auth.login", entityType: "User", entityId: user.id });
  });

  return { ...session, mustChangePassword: user.mustChangePassword, home: homePathFor(accountKindOf(roleKeys), user.mustChangePassword) };
}

/**
 * Clears a user's login limiter state (S-03): the failures ceiling and every (username, IP) bucket. Called
 * AFTER an admin unlock, admin password reset or completed password reset has committed — the account lock
 * itself is cleared in that transaction. Best effort: a limiter outage must not undo the committed unlock.
 */
export async function clearLoginLimits(username: string): Promise<void> {
  await Promise.all([resetSubject(RULES.loginFailuresPerUser, username), resetSubject(RULES.loginPerUserIp, username)]).catch(() => {
    console.error("login limiter reset failed", "RateLimitResetError");
  });
}
