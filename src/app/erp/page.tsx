import Link from "next/link";
import { KeyRound, ShieldCheck, Users } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { ROLES } from "@/lib/rbac/catalog";
import { getUsageToday } from "@/modules/system/usage.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

const LEVEL = {
  ok: { label: "OK", variant: "outline" },
  warning: { label: "Approaching limit", variant: "secondary" },
  exhausted: { label: "Paused", variant: "destructive" },
} as const;

export default async function DashboardPage() {
  const ctx = await requireAuth();
  const roleNames = ctx.roleKeys.map((k) => ROLES.find((r) => r.key === k)?.name ?? k);
  const usage = hasPermission(ctx, "usage.read") ? await getUsageToday(ctx) : null;
  const quick = [
    { href: "/erp/users", label: "Manage users", icon: Users, show: hasPermission(ctx, "user.read") },
    { href: "/erp/roles", label: "Roles & permissions", icon: ShieldCheck, show: hasPermission(ctx, "role.manage") },
    { href: "/erp/account", label: "My account", icon: KeyRound, show: true },
  ].filter((q) => q.show);

  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <PageHeader title={`Welcome, ${ctx.displayName}`} description={`Signed in as ${roleNames.join(", ") || "no role assigned"}`} />

      <section aria-labelledby="quick-heading">
        <h2 id="quick-heading" className="sr-only">
          Quick actions
        </h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {quick.map((q) => (
            <li key={q.href}>
              <Link href={q.href} className="flex min-h-14 items-center gap-3 rounded-xl border bg-background p-4 font-medium hover:bg-muted/50">
                <q.icon className="size-5 text-muted-foreground" aria-hidden="true" />
                {q.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {usage && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Free-tier usage today</h2>
            </CardTitle>
            <CardDescription>Caps are set below provider limits. At the cap, the feature falls back instead of incurring cost.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 sm:grid-cols-3">
              {usage.map((u) => (
                <li key={u.metric} className="rounded-xl border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{u.metric}</p>
                    <Badge variant={u.cap === 0 ? "secondary" : LEVEL[u.level].variant}>{u.cap === 0 ? "Disabled" : LEVEL[u.level].label}</Badge>
                  </div>
                  <p className="mt-1 text-lg font-semibold">{u.cap === 0 ? "—" : `${u.used} / ${u.cap}`}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-sm text-muted-foreground">ERP modules are added phase by phase; see the project plan.</p>
    </div>
  );
}
