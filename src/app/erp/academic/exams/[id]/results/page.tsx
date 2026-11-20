import Link from "next/link";
import { notFound } from "next/navigation";
import { FileDown } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateTime } from "@/lib/format";
import { NotFoundError } from "@/lib/errors";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { EXAM_STATUS_LABEL, type ExamStatus } from "@/modules/academic/examinations.rules";
import { RESULT_LABEL } from "@/modules/academic/results.rules";
import { getSectionResults, listResultSections } from "@/modules/academic/results.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../../../academic-tabs";
import { RemarkForm } from "./remark-form";

export const metadata = { title: "Results" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const rethrow = (e: unknown): never => {
  if (e instanceof NotFoundError) notFound();
  throw e;
};

export default async function ResultsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const { id } = await params;
  const sp = await searchParams;
  const { exam, sections } = await listResultSections(ctx, id).catch(rethrow);
  const section = sections.find((s) => s.id === sp.section) ?? sections[0];
  const [data, tz] = await Promise.all([section ? getSectionResults(ctx, { examinationId: exam.id, sectionId: section.id }).catch(rethrow) : Promise.resolve(null), getSchoolTimezone()]);
  const academicAll = hasPermission(ctx, "academic.read") && scopeFor(ctx, "academic.read") === "ALL";

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title={`Results · ${exam.name}`} description={`${exam.sessionName} · ${EXAM_STATUS_LABEL[exam.status as ExamStatus]}`} />
      <AcademicTabs current={academicAll ? "exams" : "marks"} showClasses={academicAll} showSubjects={academicAll} showAttendance={hasPermission(ctx, "attendance.student.mark")} showMarks={hasPermission(ctx, "marks.enter") || hasPermission(ctx, "marks.approve")} />
      {academicAll && (
        <p className="text-sm">
          <Link href={`/erp/academic/exams/${exam.id}`} className="underline">
            Back to {exam.name}
          </Link>
        </p>
      )}
      {sections.length > 1 && section && (
        <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="rs-section">
            Section
            <select id="rs-section" name="section" defaultValue={section.id} className={FIELD}>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" className="min-h-11">
            Show
          </Button>
        </form>
      )}
      {!data ? (
        <Alert>
          <AlertDescription>No sections take this exam.</AlertDescription>
        </Alert>
      ) : data.mode === "none" ? (
        <Alert>
          <AlertDescription>Results appear once marks entry has started.</AlertDescription>
        </Alert>
      ) : data.mode === "preview" ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{data.section.code}: preview</h2>
            </CardTitle>
            <CardDescription>Worked out from the marks entered so far with the {data.exam.scale} scale. Not published; no rank shown.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.preview.length === 0 ? (
              <p className="text-sm text-muted-foreground">No students in this section.</p>
            ) : (
              <ul className="grid gap-2">
                {data.preview.map((r) => (
                  <li key={r.enrollmentId} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-3 text-sm">
                    <span className="font-medium">
                      <span className="mr-2 tabular-nums text-muted-foreground">{r.student.rollNumber ?? "–"}</span>
                      {r.student.name}
                    </span>
                    <span className="tabular-nums">
                      {r.result
                        ? `${r.result.obtained}/${r.result.max}${r.result.percent ? ` · ${r.result.percent} %` : ""} · ${r.result.grade ?? "—"} · ${RESULT_LABEL[r.result.result]}`
                        : "Incomplete marks"}
                      {r.attendance.percent !== null && ` · attendance ${r.attendance.percent} %`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{data.section.code}: report cards ({data.cards.length})</h2>
            </CardTitle>
            <CardDescription>Published {data.publishedAt ? formatDateTime(data.publishedAt, tz) : ""}. These results are fixed.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.cards.length === 0 ? (
              <p className="text-sm text-muted-foreground">No report cards for this section.</p>
            ) : (
              <ul className="grid gap-3">
                {data.cards.map((c) => (
                  <li key={c.id} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium">
                        <span className="mr-2 tabular-nums text-muted-foreground">{c.snapshot.student.rollNumber ?? "–"}</span>
                        {c.snapshot.student.name}
                      </span>
                      <span className="flex flex-wrap items-center gap-2 tabular-nums">
                        {c.snapshot.total.obtained}/{c.snapshot.total.max}
                        {c.snapshot.total.percent && ` · ${c.snapshot.total.percent} %`} · {c.snapshot.total.grade ?? "—"}
                        {c.snapshot.rank !== null && ` · rank ${c.snapshot.rank}`}
                        <Badge variant={c.snapshot.total.result === "PASS" ? "default" : "secondary"}>{RESULT_LABEL[c.snapshot.total.result]}</Badge>
                      </span>
                    </div>
                    {data.canCard && (
                      <>
                        <a href={`/api/v1/academic/report-cards/${c.id}/pdf`} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border px-4 text-sm font-medium hover:bg-muted sm:w-auto sm:justify-self-start pointer-fine:min-h-9">
                          <FileDown aria-hidden="true" className="size-4" />
                          Report card (PDF)
                        </a>
                        <details className="rounded-lg border p-3 open:pb-4">
                          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">{c.remark ? "Edit remark" : "Add remark"}</summary>
                          <div className="mt-3">
                            <RemarkForm id={c.id} version={c.version} remark={c.remark} studentName={c.snapshot.student.name} />
                          </div>
                        </details>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
