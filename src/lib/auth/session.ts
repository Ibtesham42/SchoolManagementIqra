import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import type { Scope } from "@/lib/rbac/catalog";
import { buildPortalContext, MAX_PORTAL_CHILDREN, portalGrantRows } from "@/lib/auth/portal-context";

/**
 * Over HTTPS the cookie uses the `__Host-` prefix: browsers then require Secure, Path=/ and no
 * Domain, so a sibling subdomain can't plant or overwrite the session cookie.
 */
export function sessionCookieName(appUrl = process.env.APP_URL ?? ""): string {
  return appUrl.startsWith("https://") ? "__Host-sid" : "sid";
}

const HOUR = 60 * 60 * 1000;
/** Staff sessions: 8 h idle. Portal-only accounts' "keep me signed in": 30 days (ADR-045, `longSessionAllowed`). */
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

/**
 * Pure (review 6A-M2 M1): a staff session's idle lifetime is at most STAFF_SESSION_MS. Returns the session unchanged
 * when it already is, else a copy with `expiresAt = lastSeenAt + STAFF_SESSION_MS`.
 */
export function staffBoundedSession<T extends { lastSeenAt: Date; expiresAt: Date }>(s: T): T {
  const cap = s.lastSeenAt.getTime() + STAFF_SESSION_MS;
  return s.expiresAt.getTime() > cap ? { ...s, expiresAt: new Date(cap) } : s;
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

const PORTAL_STUDENT = {
  id: true,
  status: true,
  deletedAt: true,
  statusChanges: { orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }], take: 1, select: { effectiveDate: true } },
} satisfies Prisma.StudentSelect;

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
          // Phase 6A-M2 (ADR-044): the portal family, in the same lookup. Only used for portal-only accounts.
          guardian: {
            select: {
              deletedAt: true,
              students: {
                where: { student: { deletedAt: null } },
                orderBy: { studentId: "asc" },
                take: MAX_PORTAL_CHILDREN + 1,
                select: { portalAccess: true, student: { select: PORTAL_STUDENT } },
              },
            },
          },
          student: { select: PORTAL_STUDENT },
        },
      },
    },
  });
  if (!session) return null;

  const now = Date.now();
  const { user } = session;
  const roles = user.roles.map((ur) => ur.role);
  const roleKeys = roles.map((r) => r.key);
  const portal = buildPortalContext({ roleKeys, guardianId: user.guardianId, studentId: user.studentId, guardian: user.guardian, student: user.student });
  // Review 6A-M2 M1 (ADR-045): a staff account never keeps a long session — one issued while the account was a
  // portal account (role change) or under the old "any portal role" rule is cut back to the staff idle lifetime.
  const bounded = portal ? session : staffBoundedSession(session);
  if (bounded.expiresAt.getTime() <= now || !user.isActive || user.deletedAt) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (bounded !== session) {
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt: bounded.expiresAt } });
  }

  const renewed = nextSessionExpiry(bounded, now);
  if (renewed) {
    // Shift lastSeenAt by the same amount the expiry moved, keeping the idle lifetime invariant
    // even when the absolute cap shortens the extension.
    const idle = bounded.expiresAt.getTime() - bounded.lastSeenAt.getTime();
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: renewed, lastSeenAt: new Date(renewed.getTime() - idle) },
    });
  }

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
    roleKeys,
    isSuperAdmin: roles.some((r) => r.key === "SUPER_ADMIN" && r.isSystem),
    // Review 6A-M2 L1: a portal account keeps only its portal grants (fail closed, whatever the role was edited to).
    permissions: buildPermissionMap(portal ? portalGrantRows(rows, portal.kind) : rows),
    sessionId: session.id,
    employeeId: user.employeeId,
    portal,
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
