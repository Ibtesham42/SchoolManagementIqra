import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { ForbiddenError } from "@/lib/errors";
import { readTable, toXlsx } from "@/lib/import/tabular";
import { hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { getMarksSheet } from "./marks.service";
import { planMarksImport, TEMPLATE_HEADER, type ImportRosterRow } from "./marks-import.rules";
import { MARK_STATUS_LABEL, type Maxima } from "./marks.rules";
import type { SheetRefInput } from "./marks.schemas";

/**
 * Phase 4C-M4 — marks import for ONE marks sheet (AC19; dependencies approved 2026-11-20).
 *
 * Access = the marks grid's own: whoever may save this sheet right now (the allocated teacher while it's open, an
 * approver correcting approved marks). Reading the sheet is not enough. Deliberately NOT `import.run` / `export.run`:
 * the template holds exactly what the grid shows that user, and confirming goes through `saveMarks` (same locks,
 * versions, maxima, maker-checker history) — an import grants nothing the grid doesn't. Out of scope → NotFound.
 *
 * The upload is parsed in memory (lib/import/tabular: size, zip-bomb, row and column caps) and never stored. The
 * preview is computed here; the confirm step re-submits the planned entries, and `saveMarks` re-validates every one
 * against the database under its locks (stale version → "changed by someone else").
 */
const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });

type Sheet = Awaited<ReturnType<typeof getMarksSheet>>;

async function editableSheet(ctx: AuthContext, ref: SheetRefInput) {
  // Refused before any database access for roles that can never save marks.
  if (!hasPermission(ctx, "marks.enter") && !hasPermission(ctx, "marks.approve")) throw new ForbiddenError();
  const sheet = await getMarksSheet(ctx, ref);
  const mode = sheet.canEdit ? ("enter" as const) : sheet.canCorrect ? ("correct" as const) : null;
  if (!mode) throw new ForbiddenError("These marks can't be changed now, so there's nothing to import.");
  return { sheet, mode };
}

const PARTS = [
  ["theory", "Theory"],
  ["practical", "Practical"],
  ["internal", "Internal"],
] as const;

/** The examined parts' columns, in template order. */
export const templateColumns = (max: Maxima) => TEMPLATE_HEADER.filter((h) => !PARTS.some(([k, l]) => l === h && max[k] === 0));

function rosterOf(sheet: Sheet): ImportRosterRow[] {
  return sheet.rows.map((r) => ({
    enrollmentId: r.enrollmentId,
    studentCode: r.studentCode,
    rollNumber: r.rollNumber,
    fullName: r.fullName,
    mark: r.mark ? { status: r.mark.status, theory: r.mark.theory, practical: r.mark.practical, internal: r.mark.internal, version: r.mark.version } : null,
  }));
}

const fileStem = (sheet: Sheet) => `marks-${sheet.exam.name}-${sheet.subject.code ?? sheet.subject.name}-${sheet.section.code}`.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 80);

/** Template with the sheet's students (and saved marks) — CSV or XLSX, formula-safe, audited. */
export async function marksImportTemplate(ctx: AuthContext, ref: SheetRefInput, format: "csv" | "xlsx") {
  const { sheet } = await editableSheet(ctx, ref);
  const header = templateColumns(sheet.max);
  const cell = (r: Sheet["rows"][number], key: (typeof PARTS)[number][0]) => (!r.mark ? null : r.mark.status !== "PRESENT" ? MARK_STATUS_LABEL[r.mark.status] : r.mark[key]);
  const rows = sheet.rows.map((r) => [r.studentCode, r.rollNumber === null ? null : String(r.rollNumber), r.fullName, ...PARTS.filter(([k]) => sheet.max[k] > 0).map(([k]) => cell(r, k))]);
  const body = format === "csv" ? new TextEncoder().encode(toCsv(header, rows)) : await toXlsx(sheet.section.code, header, rows);
  await prisma.$transaction((tx) =>
    audit(tx, actorOf(ctx), { action: "marks.template", entityType: "ExamSubject", entityId: sheet.examSubjectId, after: { sectionId: sheet.section.id, rows: rows.length, format } }),
  );
  return { body, fileName: `${fileStem(sheet)}.${format}`, contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

/** Upload → preview. Writes nothing (no file stored, no marks changed). */
export async function previewMarksImport(ctx: AuthContext, ref: SheetRefInput, file: { bytes: Uint8Array; fileName: string }) {
  const { sheet, mode } = await editableSheet(ctx, ref);
  const { format, rows } = await readTable(file.bytes, file.fileName);
  const plan = planMarksImport(rows, rosterOf(sheet), sheet.max, mode === "enter");
  return {
    format,
    mode,
    sheetVersion: sheet.sheet?.version ?? null,
    plan,
    canConfirm: plan.fileProblem === null && plan.counts.problems === 0 && plan.entries.length > 0,
  };
}
