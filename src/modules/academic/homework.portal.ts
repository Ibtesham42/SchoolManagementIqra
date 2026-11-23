import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { assertPortalStudent, PORTAL_NOT_FOUND, portalScopeOf, portalVisibleChildren } from "@/lib/rbac/portal-access";
import { portalCanSee } from "@/lib/rbac/portal-scope";
import type { PortalWindow } from "@/lib/rbac/portal-scope";
import { readStoredFile } from "@/modules/files/files.service";
import { currentEnrollment } from "@/modules/students/enrollment-reads.tx";
import { portalWindow } from "@/modules/students/students.portal";

/**
 * Phase 6B-M2 (P12) — homework for families: the child's CURRENT section, due from two weeks ago onwards (recent and
 * upcoming), with subject, dates, the text and whether there is an attachment. No poster name. Leavers: none (P17).
 * Attachments: the homework must belong to the current section of a child this account can see; the file layer then
 * needs the rule's portal permission (`homework.read`) and the exact owner.
 */
const ATTACHMENT = "homework.attachment" as const;
const OWNER_TYPE = "Homework";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const RECENT_DAYS = 14;

export interface PortalHomeworkItem {
  id: string;
  subject: string;
  title: string;
  details: string;
  assignedOn: string;
  dueOn: string;
  hasAttachment: boolean;
}

export async function listPortalHomework(ctx: AuthContext, studentId: string, window?: PortalWindow) {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, studentId, "homework", w);
  const e = await currentEnrollment(prisma, studentId);
  if (!e) return null;
  const from = iso(new Date(day(w.today).getTime() - RECENT_DAYS * 86_400_000));
  const rows = await prisma.homework.findMany({
    where: { sectionId: e.sectionId, academicSessionId: e.academicSessionId, deletedAt: null, dueOn: { gte: day(from) } },
    orderBy: [{ dueOn: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, title: true, details: true, assignedOn: true, dueOn: true, classSubject: { select: { subject: { select: { name: true } } } } },
  });
  const withFiles = new Set(
    (await prisma.storedFile.findMany({ where: { purpose: ATTACHMENT, ownerType: OWNER_TYPE, ownerId: { in: rows.map((r) => r.id) }, deletedAt: null }, take: rows.length || 1, select: { ownerId: true } })).map((f) => f.ownerId),
  );
  const items: PortalHomeworkItem[] = rows.map((r) => ({
    id: r.id,
    subject: r.classSubject.subject.name,
    title: r.title,
    details: r.details,
    assignedOn: iso(r.assignedOn),
    dueOn: iso(r.dueOn),
    hasAttachment: withFiles.has(r.id),
  }));
  return { className: e.className, sectionCode: e.sectionCode, today: w.today, items };
}

/**
 * GET /api/v1/portal/homework/[id]/attachment. The homework must be in the CURRENT section of a child this account can
 * see for homework (blocked links and leavers excluded) and inside the list's window (due from today − 14, P12).
 * Review 6B-M2 L1: one query over those sections — the same work whether the id is missing or someone else's, and no
 * "first child wins" between twins. Anything else → the identical NotFound.
 */
export async function readPortalHomeworkAttachment(ctx: AuthContext, homeworkId: string, window?: PortalWindow) {
  authorize(ctx, "homework.read");
  if (!ctx.portal) throw new NotFoundError(PORTAL_NOT_FOUND); // staff use the staff route (before any database access)
  const w = window ?? (await portalWindow());
  const pairs: { sectionId: string; academicSessionId: string; studentId: string }[] = [];
  for (const c of portalVisibleChildren(ctx, w)) {
    if (!portalCanSee(ctx.portal, portalScopeOf(ctx), c.studentId, "homework", w)) continue;
    const e = await currentEnrollment(prisma, c.studentId);
    if (e) pairs.push({ sectionId: e.sectionId, academicSessionId: e.academicSessionId, studentId: c.studentId });
  }
  const from = iso(new Date(day(w.today).getTime() - RECENT_DAYS * 86_400_000));
  const h = pairs.length
    ? await prisma.homework.findFirst({
        where: { id: homeworkId, deletedAt: null, dueOn: { gte: day(from) }, OR: pairs.map(({ sectionId, academicSessionId }) => ({ sectionId, academicSessionId })) },
        select: { sectionId: true, academicSessionId: true },
      })
    : null;
  const child = h ? pairs.find((p) => p.sectionId === h.sectionId && p.academicSessionId === h.academicSessionId) : undefined;
  if (!h || !child) throw new NotFoundError(PORTAL_NOT_FOUND);
  assertPortalStudent(ctx, child.studentId, "homework", w);
  const f = await prisma.storedFile.findFirst({ where: { purpose: ATTACHMENT, ownerType: OWNER_TYPE, ownerId: homeworkId, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!f) throw new NotFoundError(PORTAL_NOT_FOUND);
  // Review 6B-M2 L5: only "not found" is a 404; a storage or key failure reaches the route's 503 (logged by name).
  const file = await readStoredFile(ctx, f.id, { purpose: ATTACHMENT, owner: { type: OWNER_TYPE, id: homeworkId } }).catch((e: unknown) => {
    if (e instanceof NotFoundError) throw new NotFoundError(PORTAL_NOT_FOUND);
    throw e;
  });
  // Review 6B-M2 L3: a non-identifying file name (plan §11) — never the uploader's original name.
  const ext = file.mimeType === "application/pdf" ? "pdf" : file.mimeType === "image/png" ? "png" : "jpg";
  return { ...file, originalName: `homework.${ext}` };
}
