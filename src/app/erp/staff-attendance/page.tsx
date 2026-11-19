import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { todayInTimeZone } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { getMyAttendance } from "@/modules/hr/staff-attendance.service";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AttendanceTabs } from "./attendance-tabs";
import { MonthView } from "./month-view";
import { attendanceTabsFor, monthParam } from "./shared";

export const metadata = { title: "My attendance" };

export default async function MyAttendancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAuth();
  const tabs = attendanceTabsFor(ctx);
  if (!hasPermission(ctx, "attendance.employee.read")) {
    if (tabs.showMark) redirect("/erp/staff-attendance/mark");
    if (tabs.showSummary) redirect("/erp/staff-attendance/summary");
    return <NotPermitted />;
  }
  const month = monthParam(await searchParams, todayInTimeZone(await getSchoolTimezone()));
  const my = await getMyAttendance(ctx, month);
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="My attendance" description="Your attendance as recorded by the school. Ask HR if something looks wrong." />
      <AttendanceTabs current="mine" {...tabs} showMine={my.linked} />
      {!my.linked ? (
        <p className="rounded-lg border p-4 text-sm">
          Your login isn&apos;t linked to your staff record yet, so there is no attendance to show. Ask a Super Admin to link it.
        </p>
      ) : (
        <MonthView
          month={my.month}
          today={my.today}
          days={my.days}
          summary={my.summary}
          locked={my.locked}
          basePath="/erp/staff-attendance"
          canMark={false}
          employeeId={my.employee.id}
        />
      )}
    </div>
  );
}
