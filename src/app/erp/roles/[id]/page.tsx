import { notFound } from "next/navigation";
import { Lock, Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { NotFoundError } from "@/lib/errors";
import { ALL_PERMISSION_KEYS, PERMISSIONS, moduleOf } from "@/lib/rbac/catalog";
import { getRole } from "@/modules/identity/roles.service";
import { actorCovers, assertCanEditRole } from "@/modules/identity/identity.policy";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { deleteRoleAction } from "../actions";
import { PermissionEditor, type PermissionRow } from "./permission-editor";
import { RoleDetailsForm } from "./role-details-form";

export const metadata = { title: "Role" };

export default async function RoleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "role.manage")) return <NotPermitted />;
  const { id } = await params;
  const role = await getRole(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });

  let editable = true;
  let lockReason = "";
  try {
    assertCanEditRole(ctx, role);
  } catch (e) {
    editable = false;
    lockReason = e instanceof Error ? e.message : "This role cannot be edited.";
  }

  const granted = new Map(role.grants.map((g) => [g.key, g.scope]));
  const rows: PermissionRow[] = ALL_PERMISSION_KEYS.map((key) => ({
    key,
    module: moduleOf(key),
    description: PERMISSIONS[key],
    scope: granted.get(key) ?? "",
    // Non–Super Admins may only change permissions they hold themselves (anti-escalation).
    locked: !editable || (!ctx.isSuperAdmin && !actorCovers(ctx, key, "SELF")),
  }));

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title={role.name} description={`${role.key} · ${role._count.users} user${role._count.users === 1 ? "" : "s"} · ${role.grants.length} permissions`} />

      {!editable && (
        <Alert>
          <Lock aria-hidden="true" />
          <AlertDescription>{lockReason}</AlertDescription>
        </Alert>
      )}

      {editable && (
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <RoleDetailsForm role={{ id: role.id, name: role.name, description: role.description ?? "" }} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
          <CardDescription>
            Scope limits which records a permission covers: <strong>All</strong> records, only <strong>assigned</strong> classes/routes,
            the user&apos;s <strong>own</strong> record, or their <strong>linked children</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PermissionEditor roleId={role.id} rows={rows} readOnly={!editable} />
        </CardContent>
      </Card>

      {editable && (
        <Card>
          <CardHeader>
            <CardTitle>Delete role</CardTitle>
            <CardDescription>{role._count.users > 0 ? "Remove this role from all users before deleting it." : "This cannot be undone."}</CardDescription>
          </CardHeader>
          {role._count.users === 0 && (
            <CardContent>
              <ConfirmAction
                label="Delete role"
                icon={<Trash2 aria-hidden="true" />}
                variant="destructive"
                title={`Delete the role "${role.name}"?`}
                description="The role and its permission settings will be removed permanently. The deletion is recorded in the audit log."
                confirmLabel="Delete"
                action={deleteRoleAction}
                fields={{ id: role.id }}
              />
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
