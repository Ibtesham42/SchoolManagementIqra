import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { formatDateTime } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { EXAM_STATUS_LABEL, type ExamStatus } from "@/modules/academic/examinations.rules";
import { SHEET_STATUS_LABEL, type SheetStatus } from "@/modules/academic/marks.rules";
import { listMyMarksSheets } from "@/modules/academic/marks.service";
import { listResultExams } from "@/modules/academic/results.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { academicTabFlags } from "../tab-flags";

export const metadata = { title: "Marks" };

const LINK = "flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export default async function MarksPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "marks.enter") && !hasPermission(ctx, "marks.approve")) return <NotPermitted />;
  const [data, tz, resultExams] = await Promise.all([listMyMarksSheets(ctx), getSchoolTimezone(), listResultExams(ctx)]);
  const academicAll = hasPermission(ctx, "academic.read") && scopeFor(ctx, "academic.read") === "ALL";

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Marks" description="Enter marks for the subjects you teach, submit them, and approve submitted marks." />
      <AcademicTabs current="marks" {...academicTabFlags(ctx)} />

      {data.enterScope === "ASSIGNED" && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>My marks sheets</h2>
            </CardTitle>
            <CardDescription>Subjects you are allocated to teach, in exams that are open for marks entry or later.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data.linked ? (
              <Alert>
                <AlertDescription>Your account isn&apos;t linked to a staff record, so no subjects are allocated to you. Ask the school office.</AlertDescription>
              </Alert>
            ) : data.mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">No exam is open for marks entry in your subjects.</p>
            ) : (
              <ul className="grid gap-2">
                {data.mine.map((m) => (
                  <li key={`${m.examSubjectId}|${m.sectionId}`}>
                    <Link href={`/erp/academic/marks/sheet?es=${m.examSubjectId}&section=${m.sectionId}`} className={LINK}>
                      <span>
                        <span className="font-medium">{m.exam}</span> · {m.sectionCode} · {m.subject}
                      </span>
                      <span className="text-muted-foreground">
                        {m.examStatus !== "MARKS_ENTRY" ? EXAM_STATUS_LABEL[m.examStatus as ExamStatus] : m.sheetStatus ? SHEET_STATUS_LABEL[m.sheetStatus as SheetStatus] : "Not started"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {hasPermission(ctx, "marks.approve") && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Waiting for approval ({data.awaiting.length})</h2>
            </CardTitle>
            <CardDescription>Submitted sheets, oldest first. You can&apos;t approve marks you entered or submitted yourself.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.awaiting.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is waiting.</p>
            ) : (
              <ul className="grid gap-2">
                {data.awaiting.map((s) => (
                  <li key={`${s.examSubjectId}|${s.sectionId}`}>
                    <Link href={`/erp/academic/marks/sheet?es=${s.examSubjectId}&section=${s.sectionId}`} className={LINK}>
                      <span>
                        <span className="font-medium">{s.exam}</span> · {s.sectionCode} · {s.subject}
                      </span>
                      <span className="text-muted-foreground">{s.submittedAt ? `Submitted ${formatDateTime(s.submittedAt, tz)}` : "Submitted"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {resultExams.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Results and report cards</h2>
            </CardTitle>
            <CardDescription>Results of your sections (a preview until published).</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {resultExams.map((e) => (
                <li key={e.id}>
                  <Link href={`/erp/academic/exams/${e.id}/results`} className={LINK}>
                    <span>
                      <span className="font-medium">{e.name}</span> · {e.academicSession.name}
                    </span>
                    <span className="text-muted-foreground">{EXAM_STATUS_LABEL[e.status as ExamStatus]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {data.enterScope === "ALL" && <p className="text-sm text-muted-foreground">You can enter marks for any sheet: open an exam on the Exams tab and choose a sheet.</p>}
    </div>
  );
}
