import Link from "next/link";
import { Download } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { todayInTimeZone } from "@/lib/format";
import { ATTENDANCE_EXPORT_MESSAGES, isExportCode } from "@/lib/http/export-errors";
import { hasPermission } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { canViewAttendanceSummary } from "@/modules/hr/hr.policy";
import { shiftMonth } from "@/modules/hr/staff-attendance.rules";
import { payrollSummarySchema } from "@/modules/hr/staff-attendance.schemas";
import { getPayrollAttendanceSummary } from "@/modules/hr/staff-attendance.service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AttendanceTabs } from "../attendance-tabs";
import { attendanceTabsFor, monthParam } from "../shared";

export const metadata = { title: "Attendance summary for payroll" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const LINK = "flex min-h-11 items-center rounded-lg border px-3 text-sm";
const COLS = [
  ["offRollsDays", "Not on rolls"],
  ["workingDays", "Working"],
  ["present", "Present"],
  ["late", "Late"],
  ["halfDays", "Half"],
  ["paidLeave", "Paid leave"],
  ["unpaidLeave", "Unpaid leave"],
  ["absent", "Absent"],
  ["unmarked", "Not marked"],
  ["lopDays", "LOP"],
] as const;

export default async function AttendanceSummaryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAuth();
  if (!canViewAttendanceSummary(ctx)) return <NotPermitted />;
  const sp = await searchParams;
  const today = todayInTimeZone(await getSchoolTimezone());
  const parsed = payrollSummarySchema.safeParse({
    month: monthParam(sp, today),
    departmentId: typeof sp.department === "string" ? sp.department : "",
    page: typeof sp.page === "string" ? sp.page : undefined,
  });
  const q = parsed.success ? parsed.data : { month: today.slice(0, 7), departmentId: null, page: 1 };
  const r = await getPayrollAttendanceSummary(ctx, q);
  const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
  const qs = (extra: Record<string, string>) =>
    new URLSearchParams({ month: r.month, ...(q.departmentId ? { department: q.departmentId } : {}), ...extra }).toString();
  const next = shiftMonth(r.month, 1);
  const exportCode = typeof sp.export === "string" ? sp.export : null;
  const canExport = hasPermission(ctx, "export.run") && r.total > 0;
  const incomplete = r.items.filter((e) => !e.summary.complete).length;

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader
        title="Attendance summary for payroll"
        description="Per employee for the whole month: paid and unpaid leave, absences and loss-of-pay (LOP) days. Unmarked days are never guessed."
      />
      <AttendanceTabs current="summary" {...attendanceTabsFor(ctx)} />
      {isExportCode(exportCode) && (
        <p role="alert" className="rounded-lg border border-destructive p-3 text-sm">
          {ATTENDANCE_EXPORT_MESSAGES[exportCode]}
        </p>
      )}
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="sum-month">
          Month
          <input id="sum-month" type="month" name="month" max={today.slice(0, 7)} defaultValue={r.month} className={FIELD} />
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="sum-department">
          Department
          <select id="sum-department" name="department" defaultValue={q.departmentId ?? ""} className={FIELD}>
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
        <Link href={`/erp/staff-attendance/summary?${qs({ month: shiftMonth(r.month, -1) })}`} className={LINK}>
          Previous month
        </Link>
        {next <= today.slice(0, 7) && (
          <Link href={`/erp/staff-attendance/summary?${qs({ month: next })}`} className={LINK}>
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
            {r.items[0] ? `${r.items[0].summary.monthWorkingDays} working day(s) in the month · ` : ""}
            {r.total} employee(s){pages > 1 ? ` · page ${r.page} of ${pages}` : ""}
            {r.locked ? " · locked for payroll" : ""}
            {incomplete > 0 ? ` · ${incomplete} on this page need review (month not over or days not marked)` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-xs text-muted-foreground">
            LOP = absent days + unpaid leave + half a day for each half day without leave. Paid leave, weekly offs and staff
            holidays are not LOP. &ldquo;Not on rolls&rdquo; = working days before joining or after leaving; payroll prorates
            on the month&apos;s working days.
          </p>
          {r.items.length > 0 && (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-sm">
                  <caption className="sr-only">Attendance summary for payroll, {r.month}</caption>
                  <thead>
                    <tr className="border-b text-left">
                      <th scope="col" className="py-2 pr-2 font-medium">
                        Employee
                      </th>
                      {COLS.map(([k, label]) => (
                        <th key={k} scope="col" className="px-2 py-2 text-right font-medium">
                          {label}
                        </th>
                      ))}
                      <th scope="col" className="px-2 py-2 font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.items.map((e) => (
                      <tr key={e.id} className="border-b last:border-0">
                        <th scope="row" className="py-2 pr-2 text-left font-normal">
                          <span className="font-medium">{e.fullName}</span>
                          <span className="block font-mono text-xs text-muted-foreground">{e.employeeCode}</span>
                        </th>
                        {COLS.map(([k]) => (
                          <td key={k} className="px-2 py-2 text-right tabular-nums">
                            {e.summary[k].toString()}
                          </td>
                        ))}
                        <td className="px-2 py-2">
                          {e.summary.complete ? <Badge variant="outline">Complete</Badge> : <Badge variant="secondary">Needs review</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="grid gap-3 md:hidden">
                {r.items.map((e) => (
                  <li key={e.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="font-medium">
                        {e.fullName}
                        <span className="block font-mono text-xs font-normal text-muted-foreground">
                          {e.employeeCode} · {e.designation}
                        </span>
                      </span>
                      {e.summary.complete ? <Badge variant="outline">Complete</Badge> : <Badge variant="secondary">Needs review</Badge>}
                    </div>
                    <dl className="mt-2 grid grid-cols-3 gap-2">
                      {COLS.map(([k, label]) => (
                        <div key={k}>
                          <dt className="text-xs text-muted-foreground">{label}</dt>
                          <dd className="tabular-nums">{e.summary[k].toString()}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            </>
          )}
          {canExport && (
            <form method="post" action="/api/v1/staff-attendance/summary/export" className="flex justify-end">
              <input type="hidden" name="month" value={r.month} />
              {q.departmentId && <input type="hidden" name="department" value={q.departmentId} />}
              <Button type="submit" variant="outline" className="min-h-11">
                <Download aria-hidden="true" /> Download CSV ({r.total})
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      {pages > 1 && (
        <nav aria-label="Pages" className="flex justify-between gap-2">
          {r.page > 1 ? (
            <Link href={`/erp/staff-attendance/summary?${qs({ page: String(r.page - 1) })}`} className={LINK}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          {r.page < pages && (
            <Link href={`/erp/staff-attendance/summary?${qs({ page: String(r.page + 1) })}`} className={LINK}>
              Next
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
