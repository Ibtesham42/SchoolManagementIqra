import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { EXAM_STATUS_LABEL, type ExamStatus } from "@/modules/academic/examinations.rules";
import { examAccess, listExams } from "@/modules/academic/examinations.service";
import { listScales } from "@/modules/academic/grading.service";
import { listSessionsForSections } from "@/modules/academic/sections.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { ExamForm } from "./exam-forms";

export const metadata = { title: "Exams" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const dates = (s: Date | null, e: Date | null) => (s ? `${formatDateOnly(s)}${e && e.getTime() !== s.getTime() ? ` – ${formatDateOnly(e)}` : ""}` : "Dates not set");

export default async function ExamsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const access = examAccess(ctx);
  if (!access.read) return <NotPermitted />;
  const sp = await searchParams;
  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === sp.session) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];
  const [exams, scales] = await Promise.all([session ? listExams(ctx, session.id) : Promise.resolve([]), access.manage ? listScales(ctx) : Promise.resolve([])]);
  const activeScales = scales.filter((s) => s.isActive).map((s) => ({ id: s.id, name: s.name }));

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Exams" description="Each exam has its own subjects, maximum marks, grading scale and report cards." />
      <AcademicTabs current="exams" showClasses showSubjects showMarks={hasPermission(ctx, "marks.enter") || hasPermission(ctx, "marks.approve")} />
      {sessions.length > 1 && (
        <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="ex-session">
            Academic session
            <select id="ex-session" name="session" defaultValue={session?.id} className={FIELD}>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" className="min-h-11">
            Show
          </Button>
        </form>
      )}
      {!session ? (
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      ) : (
        <>
          {access.manage && session.status !== "CLOSED" && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>New exam in {session.name}</h2>
                </CardTitle>
                <CardDescription>
                  {activeScales.length === 0 ? (
                    <>
                      Create a grading scale first on the <Link href="/erp/academic/grading" className="underline">Grading</Link> tab.
                    </>
                  ) : (
                    "Starts as a draft. Add subjects, then schedule it and open marks entry."
                  )}
                </CardDescription>
              </CardHeader>
              {activeScales.length > 0 && (
                <CardContent>
                  <ExamForm defaults={{ academicSessionId: session.id, name: "", gradeScaleId: "", startDate: "", endDate: "" }} scales={activeScales} />
                </CardContent>
              )}
            </Card>
          )}
          {exams.length === 0 ? (
            <p className="text-sm text-muted-foreground">No exams in {session.name} yet.</p>
          ) : (
            <ul className="grid gap-3">
              {exams.map((e) => (
                <li key={e.id}>
                  <Link href={`/erp/academic/exams/${e.id}`} className="grid min-h-11 gap-1 rounded-lg border p-3 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{e.name}</span>
                      <Badge variant={e.status === "PUBLISHED" ? "default" : "secondary"}>{EXAM_STATUS_LABEL[e.status as ExamStatus]}</Badge>
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {dates(e.startDate, e.endDate)} · {e._count.subjects} subject(s) · {e.gradeScale.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
