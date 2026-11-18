import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { canBrowseEmployees, canManageEmployees, canReadPersonal, isOwnRecord } from "@/modules/hr/hr.policy";
import { EMPLOYMENT_STATUS_LABEL, isLeaverStatus, STATUS_ACTION_LABEL, type StatusAction } from "@/modules/hr/hr.rules";
import { employeeTimeZone, getEmployee } from "@/modules/hr/employees.service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { StatusForm } from "../lifecycle-forms";

export const metadata = { title: "Employment status" };

export default async function EmployeeStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!canManageEmployees(ctx) || !canBrowseEmployees(ctx) || !canReadPersonal(ctx)) return <NotPermitted />;
  const { id } = await params;
  const [e, tz] = await Promise.all([
    getEmployee(ctx, id).catch((err) => {
      if (err instanceof NotFoundError) notFound();
      throw err;
    }),
    employeeTimeZone(ctx),
  ]);
  if (e.tier !== "personal") return <NotPermitted />;
  if (isOwnRecord(ctx, e.id) && !ctx.isSuperAdmin) return <NotPermitted />; // approver ≠ subject (service re-checks)
  // Only the transitions the status machine allows from the current status (the service re-checks).
  const available: StatusAction[] = isLeaverStatus(e.employmentStatus) ? ["REJOIN"] : e.employmentStatus === "ON_LEAVE" ? ["END_LEAVE", "RESIGN", "TERMINATE", "RETIRE"] : ["START_LEAVE", "RESIGN", "TERMINATE", "RETIRE"];

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title={`Status — ${e.fullName}`} description={`${e.employeeCode} · currently ${EMPLOYMENT_STATUS_LABEL[e.employmentStatus]}`} />
      <p>
        <Link href={`/erp/hr/employees/${e.id}`} className="text-sm underline-offset-4 hover:underline">
          ← Back to the profile
        </Link>
      </p>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Record a change</h2>
          </CardTitle>
          <CardDescription>Every change is kept in the service history. A rejoining keeps the same employee ID; the login account is not reactivated automatically.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusForm
            id={e.id}
            version={e.version}
            today={todayInTimeZone(tz)}
            actions={available.map((a) => ({ value: a, label: STATUS_ACTION_LABEL[a] }))}
            canDeactivate={hasPermission(ctx, "user.manage")}
          />
        </CardContent>
      </Card>
    </div>
  );
}
