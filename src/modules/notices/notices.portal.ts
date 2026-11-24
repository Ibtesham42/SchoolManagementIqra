import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { assertPortalStudent, PORTAL_NOT_FOUND, portalScopeOf, portalVisibleChildren } from "@/lib/rbac/portal-access";
import { portalCanSee, type PortalChild, type PortalWindow } from "@/lib/rbac/portal-scope";
import { readStoredFile } from "@/modules/files/files.service";
import { currentEnrollment } from "@/modules/students/enrollment-reads.tx";
import { portalWindow } from "@/modules/students/students.portal";
import { FAMILY_AUDIENCES, liveWhere } from "./notices.policy";

/**
 * Phase 6C-M1 (P22) — notices for families. The audience is resolved from the account's visible children (blocked
 * links and leavers excluded — notices aren't a leaver capability, P17), each child's CURRENT ACTIVE enrollment:
 * whole-school FAMILIES / ALL notices, and CLASS / SECTION notices of that child's class or section in that session.
 * Live only (published, from publishAt, before expiresAt). No author names, no targets, no read counts.
 * Opening a notice records the account's read receipt. Every refusal is the same NotFound (no existence oracle).
 */
const ATTACHMENT = "notice.attachment" as const;
const OWNER_TYPE = "Notice";

interface ChildAudience {
  studentId: string;
  academicSessionId: string;
  classId: string;
  sectionId: string;
}

/** authorize, then refuse staff contexts — before ANY database access (the settings read included). */
function gate(ctx: AuthContext): void {
  authorize(ctx, "notice.read");
  if (!ctx.portal) throw new NotFoundError(PORTAL_NOT_FOUND); // staff read through notices.service
}

/** `visible` = portalVisibleChildren(ctx, w), passed by each exported read (static guard: the check is visible there). */
async function familyAudience(ctx: AuthContext, w: PortalWindow, visible: readonly PortalChild[]): Promise<ChildAudience[]> {
  gate(ctx);
  if (!ctx.portal) throw new NotFoundError(PORTAL_NOT_FOUND);
  const out: ChildAudience[] = [];
  for (const c of visible) {
    if (!portalCanSee(ctx.portal, portalScopeOf(ctx), c.studentId, "notices", w)) continue;
    assertPortalStudent(ctx, c.studentId, "notices", w);
    const e = await currentEnrollment(prisma, c.studentId);
    if (e && e.status === "ACTIVE") out.push({ studentId: c.studentId, academicSessionId: e.academicSessionId, classId: e.classId, sectionId: e.sectionId });
  }
  return out;
}

/** Prisma filter for the notices these children's family may read now. Null when no child is in an audience. */
export function familyNoticeWhere(children: readonly ChildAudience[], now: Date, today: string) {
  if (children.length === 0) return null;
  return {
    ...liveWhere(now, today),
    audience: { in: FAMILY_AUDIENCES },
    AND: [
      {
        OR: [
          { scope: "SCHOOL" as const },
          ...children.map((c) => ({ scope: "CLASS" as const, academicSessionId: c.academicSessionId, targets: { some: { classId: c.classId } } })),
          ...children.map((c) => ({ scope: "SECTION" as const, academicSessionId: c.academicSessionId, targets: { some: { sectionId: c.sectionId } } })),
        ],
      },
    ],
  };
}

export interface PortalNoticeItem {
  id: string;
  title: string;
  publishAt: Date;
  scope: "SCHOOL" | "CLASS" | "SECTION";
  hasAttachment: boolean;
  read: boolean;
}

export async function listPortalNotices(ctx: AuthContext, window?: PortalWindow): Promise<PortalNoticeItem[]> {
  gate(ctx);
  const w = window ?? (await portalWindow());
  const where = familyNoticeWhere(await familyAudience(ctx, w, portalVisibleChildren(ctx, w)), new Date(), w.today);
  if (!where) return [];
  const rows = await prisma.notice.findMany({
    where,
    orderBy: [{ publishAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, title: true, publishAt: true, scope: true, attachmentFileId: true, reads: { where: { userId: ctx.userId }, select: { readAt: true } } },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, publishAt: r.publishAt!, scope: r.scope, hasAttachment: r.attachmentFileId !== null, read: r.reads.length > 0 }));
}

/** How many live notices this account hasn't opened yet (portal home; rendered on navigation, never polled). */
export async function countUnreadPortalNotices(ctx: AuthContext, window?: PortalWindow): Promise<number> {
  gate(ctx);
  const w = window ?? (await portalWindow());
  const where = familyNoticeWhere(await familyAudience(ctx, w, portalVisibleChildren(ctx, w)), new Date(), w.today);
  if (!where) return 0;
  return prisma.notice.count({ where: { ...where, reads: { none: { userId: ctx.userId } } } });
}

/** Opens one notice of this family's audience and records the read receipt. Anything else → NotFound. */
export async function openPortalNotice(ctx: AuthContext, id: string, window?: PortalWindow, opts: { recordRead: boolean } = { recordRead: true }) {
  gate(ctx);
  const w = window ?? (await portalWindow());
  const where = familyNoticeWhere(await familyAudience(ctx, w, portalVisibleChildren(ctx, w)), new Date(), w.today);
  const n = where ? await prisma.notice.findFirst({ where: { ...where, id }, select: { id: true, title: true, body: true, publishAt: true, expiresAt: true, attachmentFileId: true } }) : null;
  if (!n) throw new NotFoundError(PORTAL_NOT_FOUND);
  // Review 6C-M1 L2: a page opened from another site records no receipt (the caller passes recordRead: false).
  if (opts.recordRead) await prisma.noticeRead.createMany({ data: [{ noticeId: n.id, userId: ctx.userId }], skipDuplicates: true });
  return { id: n.id, title: n.title, body: n.body, publishAt: n.publishAt!, expiresAt: n.expiresAt, hasAttachment: n.attachmentFileId !== null };
}

/** GET /api/v1/portal/notices/[id]/attachment — same audience test, then the file layer (portal permission, exact owner). */
export async function readPortalNoticeAttachment(ctx: AuthContext, id: string, window?: PortalWindow) {
  gate(ctx);
  const w = window ?? (await portalWindow());
  const where = familyNoticeWhere(await familyAudience(ctx, w, portalVisibleChildren(ctx, w)), new Date(), w.today);
  const n = where ? await prisma.notice.findFirst({ where: { ...where, id }, select: { attachmentFileId: true } }) : null;
  if (!n?.attachmentFileId) throw new NotFoundError(PORTAL_NOT_FOUND);
  const file = await readStoredFile(ctx, n.attachmentFileId, { purpose: ATTACHMENT, owner: { type: OWNER_TYPE, id } }).catch((e: unknown) => {
    if (e instanceof NotFoundError) throw new NotFoundError(PORTAL_NOT_FOUND);
    throw e;
  });
  const ext = file.mimeType === "application/pdf" ? "pdf" : file.mimeType === "image/png" ? "png" : "jpg";
  return { ...file, originalName: `notice.${ext}` };
}
