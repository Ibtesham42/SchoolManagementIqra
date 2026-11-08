import Link from "next/link";
import { Lock, Plus } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { ALL_PERMISSION_KEYS } from "@/lib/rbac/catalog";
import { listRoles } from "@/modules/identity/roles.service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Roles & permissions" };

export default async function RolesPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "role.manage")) return <NotPermitted />;
  const roles = await listRoles(ctx);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Roles & permissions"
        description={`${roles.length} roles · ${ALL_PERMISSION_KEYS.length} permissions. Changes are audited and apply on each user's next page load.`}
        actions={
          <Button asChild>
            <Link href="/erp/roles/new">
              <Plus aria-hidden="true" /> New role
            </Link>
          </Button>
        }
      />
      <ul className="grid gap-2">
        {roles.map((r) => (
          <li key={r.id}>
            <Link href={`/erp/roles/${r.id}`} className="flex flex-col gap-2 rounded-xl border bg-background p-4 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium">
                  {r.name}
                  {r.isSystem && (
                    <Badge variant="secondary">
                      <Lock aria-hidden="true" /> System
                    </Badge>
                  )}
                </p>
                <p className="font-mono text-xs text-muted-foreground">{r.key}</p>
                {r.description && <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>}
              </div>
              <p className="shrink-0 text-sm text-muted-foreground">
                {r._count.permissions} permissions · {r._count.users} user{r._count.users === 1 ? "" : "s"}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
