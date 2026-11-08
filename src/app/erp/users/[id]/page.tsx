import { notFound } from "next/navigation";
import { Ban, KeyRound, LogOut, RotateCcw, Unlock } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { NotFoundError } from "@/lib/errors";
import { getUser, listAssignableRoles } from "@/modules/identity/users.service";
import { SUPER_ADMIN, assertCanModifyUser } from "@/modules/identity/identity.policy";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { PageHeader } from "@/components/erp/page-header";
import { NotPermitted } from "@/components/erp/not-permitted";
import {
  deactivateUserAction,
  reactivateUserAction,
  resetUserPasswordAction,
  revokeSessionsAction,
  unlockUserAction,
} from "../actions";
import { EditUserForm } from "./edit-user-form";

export const metadata = { title: "User" };

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "user.read")) return <NotPermitted />;
  const { id } = await params;
  const user = await getUser(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const roleKeys = user.roles.map((r) => r.role.key);
  let canModify = false;
  try {
    assertCanModifyUser(ctx, { id: user.id, roleKeys, isActive: user.isActive, permissions: user.permissions });
    canModify = true;
  } catch {
    canModify = false;
  }
  const isSelf = user.id === ctx.userId;
  const locked = user.isLocked;
  const roles = canModify
    ? (await listAssignableRoles(ctx)).map((r) => ({ ...r, disabled: !r.assignable || (r.key === SUPER_ADMIN && isSelf) }))
    : [];
  const fields = { id: user.id };

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader
        title={user.displayName}
        description={`${user.username}${user.email ? ` · ${user.email}` : ""}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Badge variant={user.isActive ? "outline" : "secondary"}>{user.isActive ? "Active" : "Inactive"}</Badge>
            {locked && <Badge variant="destructive">Locked</Badge>}
            {user.mustChangePassword && <Badge variant="secondary">Password change pending</Badge>}
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>
            Last sign-in: {user.lastLoginAt ? user.lastLoginAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never"} · Active
            sessions: {user._count.sessions}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canModify ? (
            <EditUserForm user={{ id: user.id, displayName: user.displayName, email: user.email ?? "", roleKeys }} roles={roles} />
          ) : (
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Roles</dt>
                <dd>{user.roles.map((r) => r.role.name).join(", ") || "—"}</dd>
              </div>
              {hasPermission(ctx, "user.manage") && (
                <p className="text-muted-foreground">Only a Super Admin can modify a Super Admin account.</p>
              )}
            </dl>
          )}
        </CardContent>
      </Card>

      {canModify && (
        <Card>
          <CardHeader>
            <CardTitle>Account actions</CardTitle>
            <CardDescription>Every action is recorded in the audit log.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ConfirmAction
              label="Reset password"
              icon={<KeyRound aria-hidden="true" />}
              title="Reset this user's password?"
              description="A new temporary password will be shown once. The user is signed out everywhere and must change it at next sign-in."
              confirmLabel="Reset password"
              action={resetUserPasswordAction}
              fields={fields}
            />
            <ConfirmAction
              label="Sign out of all devices"
              icon={<LogOut aria-hidden="true" />}
              title="Sign this user out everywhere?"
              description={isSelf ? "This includes this device — you will need to sign in again." : "All active sessions for this account will end immediately."}
              confirmLabel="Sign out everywhere"
              action={revokeSessionsAction}
              fields={fields}
            />
            {locked && (
              <ConfirmAction
                label="Unlock account"
                icon={<Unlock aria-hidden="true" />}
                title="Unlock this account?"
                description="The account was locked after repeated failed sign-in attempts."
                confirmLabel="Unlock"
                action={unlockUserAction}
                fields={fields}
              />
            )}
            {!isSelf &&
              (user.isActive ? (
                <ConfirmAction
                  label="Deactivate account"
                  icon={<Ban aria-hidden="true" />}
                  variant="destructive"
                  title="Deactivate this account?"
                  description="The user is signed out immediately and can no longer sign in. Their records and history are kept. You can reactivate later."
                  confirmLabel="Deactivate"
                  action={deactivateUserAction}
                  fields={fields}
                />
              ) : (
                <ConfirmAction
                  label="Reactivate account"
                  icon={<RotateCcw aria-hidden="true" />}
                  title="Reactivate this account?"
                  description="The user will be able to sign in again with their existing password."
                  confirmLabel="Reactivate"
                  action={reactivateUserAction}
                  fields={fields}
                />
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
