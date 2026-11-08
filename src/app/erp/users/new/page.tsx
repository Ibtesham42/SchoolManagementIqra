import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { NotPermitted } from "@/components/erp/not-permitted";
import { listAssignableRoles } from "@/modules/identity/users.service";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";
import { NewUserForm } from "./new-user-form";

export const metadata = { title: "New user" };

export default async function NewUserPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "user.manage")) return <NotPermitted />;
  const roles = (await listAssignableRoles(ctx)).map((r) => ({ ...r, disabled: !r.assignable }));
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New user" description="A temporary password is generated; the user must change it at first sign-in." />
      <Card>
        <CardContent>
          <NewUserForm roles={roles} />
        </CardContent>
      </Card>
    </div>
  );
}
