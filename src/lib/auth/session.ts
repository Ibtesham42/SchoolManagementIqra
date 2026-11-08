import { prisma } from "@/lib/db";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import type { Scope } from "@/lib/rbac/catalog";

/**
 * Over HTTPS the cookie uses the `__Host-` prefix: browsers then require Secure, Path=/ and no
 * Domain, so a sibling subdomain can't plant or overwrite the session cookie.
 */
export function sessionCookieName(appUrl = process.env.APP_URL ?? ""): string {
  return appUrl.startsWith("https://") ? "__Host-sid" : "sid";
}

const HOUR = 60 * 60 * 1000;
/** Staff sessions: 8 h idle. Parent/student "remember me": 30 days. */
export const STAFF_SESSION_MS = 8 * HOUR;
export const LONG_SESSION_MS = 30 * 24 * HOUR;
/** Absolute cap from sign-in, whatever the activity (docs/AUTHENTICATION_AND_RBAC.md). */
export const ABSOLUTE_SESSION_MS = 30 * 24 * HOUR;

/**
 * Pure sliding-renewal rule. The idle lifetime is `expiresAt − lastSeenAt` (both are set together
 * at creation and at each renewal, so it stays constant). Renew when less than half remains, never
 * beyond `createdAt + ABSOLUTE_SESSION_MS`. Returns the new expiry, or null when no renewal is due.
 */
export function nextSessionExpiry(s: { createdAt: Date; lastSeenAt: Date; expiresAt: Date }, now: number): Date | null {
  const idle = s.expiresAt.getTime() - s.lastSeenAt.getTime();
  const remaining = s.expiresAt.getTime() - now;
  if (idle <= 0 || remaining <= 0 || remaining >= idle / 2) return null;
  const capped = Math.min(now + idle, s.createdAt.getTime() + ABSOLUTE_SESSION_MS);
  return capped > s.expiresAt.getTime() ? new Date(capped) : null;
}

export async function createSession(userId: string, opts: { long: boolean; ipHash?: string; userAgent?: string }) {
  const token = randomToken(32);
  const ttl = opts.long ? LONG_SESSION_MS : STAFF_SESSION_MS;
  const session = await prisma.session.create({
    data: {
      tokenHash: sha256Hex(token),
      userId,
      expiresAt: new Date(Date.now() + ttl),
      ipHash: opts.ipHash,
      userAgent: opts.userAgent?.slice(0, 400),
    },
  });
  return { token, expiresAt: session.expiresAt, sessionId: session.id };
}

/**
 * Validates a raw cookie token and returns the AuthContext, or null.
 * Sliding renewal: when less than half the lifetime remains, extend it.
 */
export async function validateSessionToken(token: string): Promise<AuthContext | null> {
  if (!token || token.length > 100) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: {
      user: {
        include: {
          roles: {
            include: { role: { include: { permissions: { include: { permission: { select: { key: true } } } } } } },
          },
        },
      },
    },
  });
  if (!session) return null;

  const now = Date.now();
  const { user } = session;
  if (session.expiresAt.getTime() <= now || !user.isActive || user.deletedAt) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  const renewed = nextSessionExpiry(session, now);
  if (renewed) {
    // Shift lastSeenAt by the same amount the expiry moved, keeping the idle lifetime invariant
    // even when the absolute cap shortens the extension.
    const idle = session.expiresAt.getTime() - session.lastSeenAt.getTime();
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: renewed, lastSeenAt: new Date(renewed.getTime() - idle) },
    });
  }

  const roles = user.roles.map((ur) => ur.role);
  const rows = roles.flatMap((role) =>
    role.permissions.map((rp) => ({
      roleKey: role.key,
      isSystem: role.isSystem,
      permissionKey: rp.permission.key,
      scope: rp.scope as Scope,
    })),
  );

  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    roleKeys: roles.map((r) => r.key),
    isSuperAdmin: roles.some((r) => r.key === "SUPER_ADMIN" && r.isSystem),
    permissions: buildPermissionMap(rows),
    sessionId: session.id,
    mustChangePassword: user.mustChangePassword,
  };
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
}

/** Called on deactivation, password change and role change. */
export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
  });
  return count;
}

export async function deleteExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}
