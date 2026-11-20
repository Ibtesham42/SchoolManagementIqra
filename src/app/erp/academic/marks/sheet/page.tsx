import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Send, Undo2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateTime } from "@/lib/format";
import { NotFoundError } from "@/lib/errors";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { EXAM_STATUS_LABEL } from "@/modules/academic/examinations.rules";
import { MARK_STATUS_LABEL, SHEET_STATUS_LABEL } from "@/modules/academic/marks.rules";
import { sheetRefSchema } from "@/modules/academic/marks.schemas";
import { getMarksSheet } from "@/modules/academic/marks.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../../academic-tabs";
import { academicTabFlags } from "../../tab-flags";
import { sheetActionAction } from "../../actions";
import { MarksGrid, type GridRow } from "./marks-grid";
import { ImportPanel } from "./import-panel";
import { isExportCode, MARKS_TEMPLATE_MESSAGES } from "@/lib/http/export-errors";

export const metadata = { title: "Marks sheet" };

export default async function MarksSheetPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "marks.enter") && !hasPermission(ctx, "marks.approve") && !hasPermission(ctx, "exam.manage") && !hasPermission(ctx, "result.read")) return <NotPermitted />;
  const sp = await searchParams;
  const ref = sheetRefSchema.safeParse({ examSubjectId: sp.es, sectionId: sp.section });
  if (!ref.success) notFound();
  const [data, tz] = await Promise.all([
    getMarksSheet(ctx, ref.data).catch((e: unknown) => {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }),
    getSchoolTimezone(),
  ]);
  const academicAll = hasPermission(ctx, "academic.read") && scopeFor(ctx, "academic.read") === "ALL";
  const editable = data.canEdit || data.canCorrect;
  const rows: GridRow[] = data.rows.map((r) => ({
    enrollmentId: r.enrollmentId,
    rollNumber: r.rollNumber,
    studentCode: r.studentCode,
    fullName: r.fullName,
    status: r.mark?.status ?? "PRESENT",
    theory: r.mark?.theory ?? "",
    practical: r.mark?.practical ?? "",
    internal: r.mark?.internal ?? "",
    version: r.mark?.version ?? null,
    corrected: r.mark?.corrected ?? false,
  }));
  const fields = { examSubjectId: data.examSubjectId, sectionId: data.section.id, sheetVersion: String(data.sheet?.version ?? 1) };
  const total = data.max.theory + data.max.practical + data.max.internal;
  const show = (v: string | null, max: number) => (max === 0 ? null : (v ?? "—"));
  // Fixed text for a failed template download (never text from the URL).
  const templateError = isExportCode(sp.template) ? MARKS_TEMPLATE_MESSAGES[sp.template] : null;

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title={`${data.subject.name} · ${data.section.code}`} description={`${data.exam.name} (${data.exam.sessionName}) · out of ${total}${data.passPercent ? ` · pass ${Number(data.passPercent)} %` : ""}`} />
      <AcademicTabs current="marks" {...academicTabFlags(ctx)} />
      <p className="text-sm">
        <Link href="/erp/academic/marks" className="underline">
          Marks
        </Link>
        {academicAll && (
          <>
            {" · "}
            <Link href={`/erp/academic/exams/${data.exam.id}`} className="underline">
              {data.exam.name}
            </Link>
          </>
        )}
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <h2>Sheet</h2>
            <Badge variant={data.sheet?.status === "APPROVED" ? "default" : "secondary"}>{data.sheet ? SHEET_STATUS_LABEL[data.sheet.status] : "Not started"}</Badge>
          </CardTitle>
          <CardDescription>
            Exam: {EXAM_STATUS_LABEL[data.exam.status]} · {data.completeCount} of {data.rows.length} complete
            {data.sheet?.submittedAt && ` · submitted ${formatDateTime(data.sheet.submittedAt, tz)}${data.sheet.submittedBy ? ` by ${data.sheet.submittedBy}` : ""}`}
            {data.sheet?.approvedAt && ` · approved ${formatDateTime(data.sheet.approvedAt, tz)}${data.sheet.approvedBy ? ` by ${data.sheet.approvedBy}` : ""}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {data.canSubmit && (
            <ConfirmAction label="Submit for approval" icon={<Send aria-hidden="true" />} title="Submit these marks?" description="You can't change them after submitting unless the approver returns them." confirmLabel="Submit" action={sheetActionAction} fields={{ ...fields, action: "submit" }} />
          )}
          {data.canApprove && (
            <ConfirmAction label="Approve" icon={<CheckCircle2 aria-hidden="true" />} title="Approve these marks?" description="Approved marks are fixed; later corrections need a reason." confirmLabel="Approve" action={sheetActionAction} fields={{ ...fields, action: "approve" }} />
          )}
          {data.canReturn && (
            <ConfirmAction label="Return to teacher" icon={<Undo2 aria-hidden="true" />} title="Return these marks?" description="The teacher can change and submit them again." confirmLabel="Return" action={sheetActionAction} fields={{ ...fields, action: "return" }} />
          )}
          {data.approveBlocker && <p className="text-sm text-muted-foreground">{data.approveBlocker}</p>}
          {!editable && !data.canSubmit && !data.canApprove && !data.canReturn && (
            <p className="text-sm text-muted-foreground">
              {data.exam.status !== "MARKS_ENTRY" && data.exam.status !== "LOCKED"
                ? "The exam isn't open for marks entry."
                : data.sheet?.status === "SUBMITTED"
                  ? "Submitted and waiting for approval."
                  : data.sheet?.status === "APPROVED"
                    ? "Approved."
                    : "Read only."}
            </p>
          )}
        </CardContent>
      </Card>

      {editable && data.rows.length > 0 && <ImportPanel examSubjectId={data.examSubjectId} sectionId={data.section.id} correction={!data.canEdit && data.canCorrect} templateError={templateError} />}

      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No students take this subject in this section.</p>
      ) : editable ? (
        <MarksGrid examSubjectId={data.examSubjectId} sectionId={data.section.id} sheetVersion={data.sheet?.version ?? null} rows={rows} max={data.max} correction={!data.canEdit && data.canCorrect} />
      ) : (
        <ul className="grid gap-2">
          {data.rows.map((r) => (
            <li key={r.enrollmentId} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-3 text-sm">
              <span className="font-medium">
                <span className="mr-2 tabular-nums text-muted-foreground">{r.rollNumber ?? "–"}</span>
                {r.fullName}
              </span>
              <span className="tabular-nums">
                {!r.mark
                  ? "Not entered"
                  : r.mark.status !== "PRESENT"
                    ? MARK_STATUS_LABEL[r.mark.status]
                    : [show(r.mark.theory, data.max.theory), show(r.mark.practical, data.max.practical), show(r.mark.internal, data.max.internal)].filter((v) => v !== null).join(" + ")}
                {r.mark?.corrected && " (corrected)"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
