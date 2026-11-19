import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { todayInTimeZone } from "@/lib/format";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { listSections, listSessionsForSections } from "@/modules/academic/sections.service";
import { studentMonthSchema } from "@/modules/students/student-attendance.schemas";
import { getStudentMonth } from "@/modules/students/student-attendance.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Student attendance register" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const COLS = [
  ["present", "Present"],
  ["late", "Late"],
  ["halfDay", "Half"],
  ["absent", "Absent"],
  ["excused", "Excused"],
  ["unmarked", "Not marked"],
] as const;

export default async function StudentRegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const allowed = hasPermission(ctx, "attendance.student.mark") || hasPermission(ctx, "attendance.student.read") || hasPermission(ctx, "academic.manage");
  const academicScope = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  if (!allowed || (academicScope !== "ALL" && academicScope !== "ASSIGNED")) return <NotPermitted />;
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const today = todayInTimeZone(await getSchoolTimezone());
  const asked = studentMonthSchema.shape.month.safeParse(pick("month") ?? "");
  const month = asked.success && asked.data <= today.slice(0, 7) ? asked.data : today.slice(0, 7);
  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === currentId) ?? sessions[0];
  const sections = session ? await listSections(ctx, { academicSessionId: session.id }) : [];
  const section = sections.find((s) => s.id === pick("section")) ?? sections[0];
  if (!section) {
    return (
      <div className="mx-auto grid max-w-5xl gap-4">
        <PageHeader title="Student attendance register" />
        <Alert>
          <AlertDescription>No section to show.</AlertDescription>
        </Alert>
      </div>
    );
  }
  const r = await getStudentMonth(ctx, { sectionId: section.id, month });
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader
        title="Student attendance register"
        description="Monthly counts per student. Attendance % = (present + late + ½ half days) ÷ marked school days."
        actions={
          <Link href={`/erp/academic/attendance?section=${section.id}`} className="flex min-h-11 items-center rounded-lg border px-3 text-sm">
            Mark a day
          </Link>
        }
      />
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="sr-section">
          Section
          <select id="sr-section" name="section" defaultValue={section.id} className={FIELD}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="sr-month">
          Month
          <input id="sr-month" type="month" name="month" max={today.slice(0, 7)} defaultValue={month} className={FIELD} />
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Show
        </Button>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>
              {r.section.code} · {month}
            </h2>
          </CardTitle>
          <CardDescription>
            {r.schoolDays} school day(s) so far · {r.items.length} student(s). Excused days are shown separately and count as not attended (AC21).
          </CardDescription>
        </CardHeader>
        {r.items.length > 0 && (
          <CardContent>
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <caption className="sr-only">Attendance counts for {r.section.code}, {month}</caption>
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-2 font-medium">Student</th>
                    {COLS.map(([k, label]) => (
                      <th key={k} scope="col" className="px-2 py-2 text-right font-medium">
                        {label}
                      </th>
                    ))}
                    <th scope="col" className="px-2 py-2 text-right font-medium">%</th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((e) => (
                    <tr key={e.enrollmentId} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        <span className="mr-2 tabular-nums text-muted-foreground">{e.rollNumber ?? "–"}</span>
                        <span className="font-medium">{e.fullName}</span>
                      </th>
                      {COLS.map(([k]) => (
                        <td key={k} className="px-2 py-2 text-right tabular-nums">
                          {e.summary[k]}
                        </td>
                      ))}
                      <td className="px-2 py-2 text-right tabular-nums">{e.summary.percent ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="grid gap-3 md:hidden">
              {r.items.map((e) => (
                <li key={e.enrollmentId} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">
                      <span className="mr-2 tabular-nums text-muted-foreground">{e.rollNumber ?? "–"}</span>
                      {e.fullName}
                    </span>
                    <span className="tabular-nums">{e.summary.percent ? `${e.summary.percent} %` : "—"}</span>
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-2">
                    {COLS.map(([k, label]) => (
                      <div key={k}>
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="tabular-nums">{e.summary[k]}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
