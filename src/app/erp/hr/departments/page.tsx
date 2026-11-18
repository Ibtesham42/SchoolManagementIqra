import { requireAuth } from "@/lib/auth/context";
import { canBrowseEmployees, canManageEmployees } from "@/modules/hr/hr.policy";
import { listDepartments } from "@/modules/hr/master-data.service";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { HrTabs } from "../hr-tabs";
import { MasterList } from "../master-list";

export const metadata = { title: "Departments" };

export default async function DepartmentsPage() {
  const ctx = await requireAuth();
  if (!canBrowseEmployees(ctx)) return <NotPermitted />;
  const rows = await listDepartments(ctx, { includeInactive: true });
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="Departments"
        description="The school's departments. Never deleted — deactivate one that is no longer used."
      />
      <HrTabs current="departments" />
      <MasterList
        kind="department"
        rows={rows}
        canManage={canManageEmployees(ctx)}
      />
    </div>
  );
}
