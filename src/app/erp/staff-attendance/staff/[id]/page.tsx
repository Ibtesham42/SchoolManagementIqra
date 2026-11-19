import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { employeeMonthSchema } from "@/modules/hr/staff-attendance.schemas";
import { getEmployeeAttendanceMonth } from "@/modules/hr/staff-attendance.service";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { MonthView } from "../../month-view";
import { monthParam } from "../../shared";

export const metadata = { title: "Staff attendance" };

export default async function EmployeeAttendancePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "attendance.employee.read")) return <NotPermitted />;
  const { id } = await params;
  const month = monthParam(await searchParams, todayInTimeZone(await getSchoolTimezone()));
  const input = employeeMonthSchema.safeParse({ employeeId: id, month });
  if (!input.success) notFound();
  const m = await getEmployeeAttendanceMonth(ctx, input.data).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title={m.employee.fullName}
        description={`${m.employee.employeeCode} · ${m.employee.designation} · ${m.employee.department}`}
        actions={
          <Link href={`/erp/staff-attendance/register?month=${m.month}`} className="flex min-h-11 items-center rounded-lg border px-3 text-sm">
            Back to register
          </Link>
        }
      />
      {m.own && <p className="rounded-lg border p-3 text-sm">This is your own record. Someone else must mark or correct it.</p>}
      <MonthView
        month={m.month}
        today={m.today}
        days={m.days}
        summary={m.summary}
        locked={m.locked}
        basePath={`/erp/staff-attendance/staff/${m.employee.id}`}
        canMark={m.canMark}
        employeeId={m.employee.id}
      />
    </div>
  );
}
