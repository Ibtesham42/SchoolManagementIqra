import { requireAuth } from "@/lib/auth/context";
import { canBrowseEmployees, canManageEmployees } from "@/modules/hr/hr.policy";
import { listDesignations } from "@/modules/hr/master-data.service";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { HrTabs } from "../hr-tabs";
import { MasterList } from "../master-list";

export const metadata = { title: "Designations" };

export default async function DesignationsPage() {
  const ctx = await requireAuth();
  if (!canBrowseEmployees(ctx)) return <NotPermitted />;
  const rows = await listDesignations(ctx, { includeInactive: true });
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Designations" description="Job titles for staff, teaching or non-teaching. Never deleted — deactivate one that is no longer used." />
      <HrTabs current="designations" />
      <MasterList kind="designation" rows={rows} canManage={canManageEmployees(ctx)} />
    </div>
  );
}
