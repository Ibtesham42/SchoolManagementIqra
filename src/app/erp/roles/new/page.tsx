import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { Card, CardContent } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { NewRoleForm } from "./new-role-form";

export const metadata = { title: "New role" };

export default async function NewRolePage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "role.manage")) return <NotPermitted />;
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="New role" description="Create the role, then choose its permissions." />
      <Card>
        <CardContent>
          <NewRoleForm />
        </CardContent>
      </Card>
    </div>
  );
}
