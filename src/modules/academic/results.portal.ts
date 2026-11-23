import { createElement } from "react";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { renderPdf } from "@/lib/pdf/render";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { assertPortalStudent, PORTAL_NOT_FOUND } from "@/lib/rbac/portal-access";
import type { PortalWindow } from "@/lib/rbac/portal-scope";
import { loadBranding } from "@/modules/documents/documents.service";
import { ReportCardDocument } from "@/modules/documents/templates/report-card";
import { portalWindow } from "@/modules/students/students.portal";
import { readSnapshot } from "./results.rules";

/**
 * Phase 6B-M2 (P11) — published report cards for families. A ReportCard row exists only after publication, so marks
 * before publication are never reachable. All sessions of the child; leavers keep them inside the window (P17).
 * The PDF is the PUBLISHED SNAPSHOT (later mark or scale edits change nothing), stamped "PARENT COPY", never counted
 * as a print, audited as a view. Anything not this account's → the identical NotFound (no existence oracle).
 */
const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const MAX_CARDS = 60;

export interface PortalReportCardItem {
  id: string;
  examName: string;
  sessionName: string;
  publishedOn: string;
  result: "PASS" | "FAIL" | "NO_RESULT" | null;
  percent: string | null;
}

export async function listPortalReportCards(ctx: AuthContext, studentId: string, window?: PortalWindow): Promise<PortalReportCardItem[]> {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, studentId, "results", w);
  const cards = await prisma.reportCard.findMany({
    // Defence in depth (review 6B-M2): cards exist only after publication; also require a PUBLISHED exam in case an
    // "unpublish" is ever added (KI-091).
    where: { enrollment: { studentId, student: { deletedAt: null } }, examination: { status: "PUBLISHED" } },
    orderBy: [{ publishedAt: "desc" }, { id: "asc" }],
    take: MAX_CARDS,
    select: { id: true, snapshot: true, publishedAt: true, academicSession: { select: { name: true } }, examination: { select: { name: true } } },
  });
  return cards.map((c) => {
    const s = readSnapshot(c.snapshot);
    return {
      id: c.id,
      examName: s?.exam.name ?? c.examination.name,
      sessionName: s?.exam.session ?? c.academicSession.name,
      publishedOn: c.publishedAt.toISOString().slice(0, 10),
      result: s?.total.result ?? null,
      percent: s?.total.percent ?? null,
    };
  });
}

/** GET /api/v1/portal/report-cards/[id]/pdf — the parent copy of one published card. */
export async function renderPortalReportCardPdf(ctx: AuthContext, id: string, window?: PortalWindow): Promise<{ pdf: Buffer; fileName: string }> {
  // Refuse non-portal contexts before any database access (staff use the staff route).
  authorize(ctx, "result.read");
  if (!ctx.portal) throw new NotFoundError(PORTAL_NOT_FOUND);
  const w = window ?? (await portalWindow());
  const card = await prisma.reportCard.findUnique({
    where: { id },
    select: { id: true, snapshot: true, remark: true, publishedAt: true, examination: { select: { status: true } }, enrollment: { select: { studentId: true, student: { select: { deletedAt: true } } } } },
  });
  if (!card || card.enrollment.student.deletedAt || card.examination.status !== "PUBLISHED") throw new NotFoundError(PORTAL_NOT_FOUND);
  assertPortalStudent(ctx, card.enrollment.studentId, "results", w); // same NotFound for "not yours"
  const snapshot = readSnapshot(card.snapshot);
  if (!snapshot) throw new ConflictError("This report card can't be shown (unknown format). Please contact the school office.");
  const branding = await loadBranding();
  const pdf = await renderPdf(createElement(ReportCardDocument, { branding, snapshot, remark: card.remark, publishedAt: card.publishedAt, generatedAt: new Date(), copy: "PARENT COPY" }));
  await prisma.$transaction((tx) => audit(tx, actorOf(ctx), { action: "report_card.portal_view", entityType: "ReportCard", entityId: card.id }));
  return { pdf, fileName: "report-card.pdf" }; // non-identifying name (plan §11)
}
