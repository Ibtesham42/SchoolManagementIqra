import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly, todayInTimeZone } from "@/lib/format";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { listSections, listSessionsForSections } from "@/modules/academic/sections.service";
import { studentDaySchema } from "@/modules/students/student-attendance.schemas";
import { getStudentDay } from "@/modules/students/student-attendance.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { StudentDayForm, type StudentRow } from "./student-day-form";

export const metadata = { title: "Student attendance" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

export default async function StudentAttendancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const allowed = hasPermission(ctx, "attendance.student.mark") || hasPermission(ctx, "attendance.student.read") || hasPermission(ctx, "academic.manage");
  const academicScope = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  if (!allowed || (academicScope !== "ALL" && academicScope !== "ASSIGNED")) return <NotPermitted />;
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const today = todayInTimeZone(await getSchoolTimezone());
  // Review 4A L2: a real calendar date (2026-02-31 is refused, not rolled into March), never in the future.
  const asked = studentDaySchema.shape.date.safeParse(pick("date") ?? "");
  const date = asked.success && asked.data <= today ? asked.data : today;

  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === currentId) ?? sessions[0];
  // Class teachers (ASSIGNED) see only their own section(s).
  const sections = session ? await listSections(ctx, { academicSessionId: session.id }) : [];
  const section = sections.find((s) => s.id === pick("section")) ?? sections[0];
  const linked = typeof ctx.employeeId === "string" && ctx.employeeId !== "";

  const header = (
    <>
      <PageHeader title="Student attendance" description="Daily attendance by section. Everyone starts as present — tap the exceptions and save once." />
      <AcademicTabs
        current="attendance"
        showClasses={academicScope === "ALL"}
        showSubjects={academicScope === "ALL"}
        showTimetable={hasPermission(ctx, "timetable.read")}
        showMine={linked && hasPermission(ctx, "timetable.read")}
        showAttendance
      />
    </>
  );
  if (!session || !section) {
    return (
      <div className="mx-auto grid max-w-4xl gap-4">
        {header}
        <Alert>
          <AlertDescription>{!session ? "No academic session exists yet." : academicScope === "ASSIGNED" ? "You aren't class teacher of a section in the current session." : "No sections yet."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const data = await getStudentDay(ctx, { sectionId: section.id, date });
  const rows: StudentRow[] = data.roster.map((r) => ({
    enrollmentId: r.enrollmentId,
    rollNumber: r.rollNumber,
    studentCode: r.studentCode,
    fullName: r.fullName,
    status: r.mark?.status ?? null,
    version: r.mark?.version ?? null,
    editable: r.mark ? data.canChangeSaved : data.canMarkNew,
  }));
  const marked = data.roster.filter((r) => r.mark).length;
  const absent = data.roster.filter((r) => r.mark?.status === "ABSENT").length;

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      {header}
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="sa-section">
          Section
          <select id="sa-section" name="section" defaultValue={section.id} className={FIELD}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="sa-date">
          Date
          <input id="sa-date" type="date" name="date" max={today} defaultValue={date} className={FIELD} />
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Show
        </Button>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>
              {data.section.code} · {formatDateOnly(new Date(`${date}T00:00:00.000Z`))}
            </h2>
          </CardTitle>
          <CardDescription>
            {data.roster.length} student(s) · {marked} marked{absent ? ` · ${absent} absent` : ""} ·{" "}
            <Link href={`/erp/academic/attendance/register?section=${section.id}&month=${date.slice(0, 7)}`} className="underline">
              month register
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.blocker ? (
            <p className="rounded-lg border p-3 text-sm">{data.blocker} Nothing can be marked for this date.</p>
          ) : data.roster.length === 0 ? (
            <p className="text-sm text-muted-foreground">No students were enrolled in this section on this date.</p>
          ) : (
            <>
              {!data.canMarkNew && !data.canChangeSaved && (
                <p className="mb-3 rounded-lg border p-3 text-sm">
                  {marked > 0 ? "Saved marks of earlier days can only be corrected by the school office." : "Only the class teacher or the school office can mark this section."}
                </p>
              )}
              <StudentDayForm key={`${section.id}|${date}`} sectionId={section.id} date={date} rows={rows} reasonRequired={data.reasonRequired} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
