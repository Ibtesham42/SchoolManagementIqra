import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly, todayInTimeZone } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { ATTENDANCE_STATUS_LABEL } from "@/modules/hr/staff-attendance.rules";
import { attendanceDayQuerySchema } from "@/modules/hr/staff-attendance.schemas";
import { getAttendanceDay } from "@/modules/hr/staff-attendance.service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AttendanceTabs } from "../attendance-tabs";
import { MarkDayForm, type MarkRow } from "../mark-forms";
import { attendanceTabsFor } from "../shared";

export const metadata = { title: "Mark staff attendance" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

export default async function MarkAttendancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "attendance.employee.mark")) return <NotPermitted />;
  const sp = await searchParams;
  const today = todayInTimeZone(await getSchoolTimezone());
  const parsed = attendanceDayQuerySchema.safeParse({
    date: typeof sp.date === "string" ? sp.date : today,
    departmentId: typeof sp.department === "string" ? sp.department : "",
  });
  const q = parsed.success ? parsed.data : { date: today, departmentId: null };
  const dayData = await getAttendanceDay(ctx, q);
  const linked = (typeof ctx.employeeId === "string" && ctx.employeeId !== "") || ctx.isSuperAdmin;

  const isFixed = (e: (typeof dayData.employees)[number]) => e.own || (e.mark !== null && e.mark.leaveCode !== null);
  const fixed = dayData.employees.filter(isFixed);
  const rows: MarkRow[] = dayData.employees
    .filter((e) => !isFixed(e))
    .map((e) => ({
      id: e.id,
      employeeCode: e.employeeCode,
      fullName: e.fullName,
      subtitle: `${e.designation} · ${e.department}`,
      status: e.mark?.status ?? null,
      checkIn: e.mark?.checkIn ?? null,
      checkOut: e.mark?.checkOut ?? null,
      version: e.mark?.version ?? null,
    }));
  const marked = dayData.employees.filter((e) => e.mark).length;

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Mark staff attendance" description="Everyone starts as present — tap the exceptions and save once." />
      <AttendanceTabs current="mark" {...attendanceTabsFor(ctx)} />
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="day-date">
          Date
          <input id="day-date" type="date" name="date" max={today} defaultValue={dayData.date} className={FIELD} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="day-department">
          Department
          <select id="day-department" name="department" defaultValue={q.departmentId ?? ""} className={FIELD}>
            <option value="">All departments</option>
            {dayData.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Show
        </Button>
      </form>
      {!linked && (
        <p className="rounded-lg border p-4 text-sm">
          Your login isn&apos;t linked to your staff record yet, so you can&apos;t mark attendance. Ask a Super Admin to link it.
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{formatDateOnly(new Date(`${dayData.date}T00:00:00.000Z`))}</h2>
          </CardTitle>
          <CardDescription>
            {dayData.employees.length} on the staff rolls · {marked} marked
            {dayData.truncated ? " · showing the first 500 — choose a department" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {dayData.blocker ? (
            <p className="rounded-lg border p-3 text-sm">{dayData.blocker} Nothing can be marked for this date.</p>
          ) : !linked ? null : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody to mark here.</p>
          ) : (
            <MarkDayForm
              key={`${dayData.date}|${q.departmentId ?? ""}`}
              date={dayData.date}
              rows={rows}
              hasSaved={rows.some((r) => r.version !== null)}
            />
          )}
          {fixed.length > 0 && (
            <section aria-labelledby="fixed-heading" className="grid gap-2">
              <h3 id="fixed-heading" className="text-sm font-medium">
                Not editable here
              </h3>
              <ul className="grid gap-2">
                {fixed.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                    <span>
                      {e.fullName} <span className="font-mono text-xs text-muted-foreground">{e.employeeCode}</span>
                    </span>
                    {e.own ? (
                      <Badge variant="secondary">Your own record</Badge>
                    ) : (
                      <Badge variant="outline">
                        {ATTENDANCE_STATUS_LABEL[e.mark?.status ?? ""] ?? ""}
                        {e.mark?.leaveCode ? ` (${e.mark.leaveCode})` : ""}
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {hasPermission(ctx, "attendance.employee.read") && (
            <p className="text-xs text-muted-foreground">
              Earlier days can also be corrected from an employee&apos;s month in the{" "}
              <Link href="/erp/staff-attendance/register" className="underline">
                monthly register
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
