import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { todayInTimeZone } from "@/lib/format";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { shiftMonth } from "@/modules/hr/staff-attendance.rules";
import { attendanceRegisterSchema } from "@/modules/hr/staff-attendance.schemas";
import { getAttendanceRegister } from "@/modules/hr/staff-attendance.service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AttendanceTabs } from "../attendance-tabs";
import { attendanceTabsFor, monthParam } from "../shared";

export const metadata = { title: "Staff attendance register" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const LINK = "flex min-h-11 items-center rounded-lg border px-3 text-sm";
const COLS = [
  ["present", "Present"],
  ["late", "Late"],
  ["halfDay", "Half day"],
  ["onLeave", "Leave"],
  ["halfDayLeave", "½ leave"],
  ["absent", "Absent"],
  ["unmarked", "Not marked"],
] as const;

export default async function AttendanceRegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "attendance.employee.read") || scopeFor(ctx, "attendance.employee.read") !== "ALL") {
    return <NotPermitted />;
  }
  const sp = await searchParams;
  const today = todayInTimeZone(await getSchoolTimezone());
  const parsed = attendanceRegisterSchema.safeParse({
    month: monthParam(sp, today),
    departmentId: typeof sp.department === "string" ? sp.department : "",
    page: typeof sp.page === "string" ? sp.page : undefined,
  });
  const q = parsed.success ? parsed.data : { month: today.slice(0, 7), departmentId: null, page: 1 };
  const r = await getAttendanceRegister(ctx, q);
  const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
  const qs = (extra: Record<string, string>) =>
    new URLSearchParams({ month: r.month, ...(q.departmentId ? { department: q.departmentId } : {}), ...extra }).toString();
  const next = shiftMonth(r.month, 1);

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader title="Staff attendance register" description="Monthly counts per employee. Open an employee for the day-by-day view." />
      <AttendanceTabs current="register" {...attendanceTabsFor(ctx)} />
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="reg-month">
          Month
          <input id="reg-month" type="month" name="month" max={today.slice(0, 7)} defaultValue={r.month} className={FIELD} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="reg-department">
          Department
          <select id="reg-department" name="department" defaultValue={q.departmentId ?? ""} className={FIELD}>
            <option value="">All departments</option>
            {r.departments.map((d) => (
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
      <nav aria-label="Month" className="flex justify-between gap-2">
        <Link href={`/erp/staff-attendance/register?${qs({ month: shiftMonth(r.month, -1) })}`} className={LINK}>
          Previous month
        </Link>
        {next <= today.slice(0, 7) && (
          <Link href={`/erp/staff-attendance/register?${qs({ month: next })}`} className={LINK}>
            Next month
          </Link>
        )}
      </nav>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{r.month}</h2>
          </CardTitle>
          <CardDescription>
            {r.workingDaysInMonth} working day(s) in the month · {r.total} employee(s)
            {pages > 1 ? ` · page ${r.page} of ${pages}` : ""}
            {r.locked ? " · locked for payroll" : ""}
          </CardDescription>
        </CardHeader>
        {r.items.length > 0 && (
          <CardContent>
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <caption className="sr-only">Attendance counts for {r.month}</caption>
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-2 font-medium">
                      Employee
                    </th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">
                      Days so far
                    </th>
                    {COLS.map(([k, label]) => (
                      <th key={k} scope="col" className="px-2 py-2 text-right font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        <Link
                          href={`/erp/staff-attendance/staff/${e.id}?month=${r.month}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {e.fullName}
                        </Link>
                        <span className="block font-mono text-xs text-muted-foreground">{e.employeeCode}</span>
                      </th>
                      <td className="px-2 py-2 text-right tabular-nums">{e.summary.workingDays}</td>
                      {COLS.map(([k]) => (
                        <td key={k} className="px-2 py-2 text-right tabular-nums">
                          {e.summary[k]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="grid gap-3 md:hidden">
              {r.items.map((e) => (
                <li key={e.id} className="rounded-lg border p-3 text-sm">
                  <Link
                    href={`/erp/staff-attendance/staff/${e.id}?month=${r.month}`}
                    className="flex min-h-11 flex-col justify-center font-medium"
                  >
                    {e.fullName}
                    <span className="font-mono text-xs font-normal text-muted-foreground">
                      {e.employeeCode} · {e.designation}
                    </span>
                  </Link>
                  <dl className="mt-2 grid grid-cols-4 gap-2">
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
      {pages > 1 && (
        <nav aria-label="Pages" className="flex justify-between gap-2">
          {r.page > 1 ? (
            <Link href={`/erp/staff-attendance/register?${qs({ page: String(r.page - 1) })}`} className={LINK}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          {r.page < pages && (
            <Link href={`/erp/staff-attendance/register?${qs({ page: String(r.page + 1) })}`} className={LINK}>
              Next
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
