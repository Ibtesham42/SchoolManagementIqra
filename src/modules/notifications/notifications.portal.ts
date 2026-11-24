import { prisma } from "@/lib/db";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import type { AuthContext } from "@/lib/rbac/authorize";
import { PORTAL_NOT_FOUND, portalScopeOf, portalVisibleChildren } from "@/lib/rbac/portal-access";
import { portalCanSee, type PortalChild, type PortalWindow } from "@/lib/rbac/portal-scope";
import { visibleFamilyNoticeIds } from "@/modules/notices/notices.portal";
import { portalWindow } from "@/modules/students/students.portal";
import { isPortalLink, notificationTarget } from "./notifications.service";

/**
 * Phase 6C-M2 — the portal inbox and bell (review 6C-M2 M1, M2, L1–L3). A stored notification is shown, counted or
 * opened only while the account may still see what it is about, with the same rules as the pages it links to:
 * - per-student rows (absence / result / receipt): `portalCanSee` for that student and capability — so a custody block
 *   (however it came about: the office, a guardian merge, or a race with a fan-out), a leaver outside the window, a
 *   removed student, or a student account and fees all hide it at the next request;
 * - notice rows: the notice is still live and in this family's audience (withdrawn / expired / moved away → hidden);
 * - anything else: hidden.
 * Own rows only (userId = ctx.userId). Staff contexts are refused before any database access.
 */
const SCAN = 200;
const SHOWN = 50;

function gate(ctx: AuthContext): void {
  if (!ctx.portal) throw new NotFoundError(PORTAL_NOT_FOUND);
}

interface Row {
  id: string;
  dedupeKey: string | null;
}

async function visibleIds(ctx: AuthContext, w: PortalWindow, visible: readonly PortalChild[], rows: readonly Row[]): Promise<Set<string>> {
  if (!ctx.portal) return new Set();
  const family = { ...ctx.portal, children: visible };
  const scopeOf = portalScopeOf(ctx);
  const targets = rows.map((r) => ({ id: r.id, t: notificationTarget(r.dedupeKey) }));
  const noticeIds = targets.flatMap(({ t }) => (t?.kind === "notice" ? [t.noticeId] : []));
  // An account whose role lost notice.read simply sees no notice rows (never an error page).
  const liveNotices = noticeIds.length
    ? await visibleFamilyNoticeIds(ctx, [...new Set(noticeIds)], w).catch((e: unknown) => {
        if (e instanceof ForbiddenError || e instanceof NotFoundError) return new Set<string>();
        throw e;
      })
    : new Set<string>();
  return new Set(
    targets.filter(({ t }) => (t?.kind === "student" ? portalCanSee(family, scopeOf, t.studentId, t.capability, w) : t?.kind === "notice" ? liveNotices.has(t.noticeId) : false)).map(({ id }) => id),
  );
}

/** Newest first, at most 50 that are still visible (scans the newest 200). */
export async function listPortalNotifications(ctx: AuthContext, window?: PortalWindow) {
  gate(ctx);
  const w = window ?? (await portalWindow());
  const visible = portalVisibleChildren(ctx, w);
  const rows = await prisma.notification.findMany({
    where: { userId: ctx.userId, channel: "IN_APP" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SCAN,
    select: { id: true, dedupeKey: true, title: true, body: true, createdAt: true, readAt: true },
  });
  const ok = await visibleIds(ctx, w, visible, rows);
  return rows.filter((r) => ok.has(r.id)).slice(0, SHOWN).map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.createdAt, readAt: r.readAt }));
}

/** The bell's unread count (rendered on navigation, never polled — plan R2): visible unread rows, at most 200 scanned. */
export async function countPortalUnread(ctx: AuthContext, window?: PortalWindow): Promise<number> {
  gate(ctx);
  const w = window ?? (await portalWindow());
  const visible = portalVisibleChildren(ctx, w);
  const rows = await prisma.notification.findMany({ where: { userId: ctx.userId, channel: "IN_APP", readAt: null }, orderBy: { createdAt: "desc" }, take: SCAN, select: { id: true, dedupeKey: true } });
  return rows.length ? (await visibleIds(ctx, w, visible, rows)).size : 0;
}

/** Marks one visible notification of this account read and returns its portal path. Anything else → NotFound. */
export async function openPortalNotification(ctx: AuthContext, id: string, window?: PortalWindow): Promise<string> {
  gate(ctx);
  const w = window ?? (await portalWindow());
  const visible = portalVisibleChildren(ctx, w);
  const n = await prisma.notification.findFirst({ where: { id, userId: ctx.userId }, select: { id: true, dedupeKey: true, link: true, readAt: true } });
  if (!n || !(await visibleIds(ctx, w, visible, [n])).has(n.id)) throw new NotFoundError(PORTAL_NOT_FOUND);
  if (!n.readAt) await prisma.notification.updateMany({ where: { id: n.id, userId: ctx.userId, readAt: null }, data: { readAt: new Date() } });
  return isPortalLink(n.link) ? n.link : "/portal/inbox";
}
