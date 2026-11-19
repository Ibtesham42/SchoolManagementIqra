import { CheckCircle2, CircleOff } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { listComponents } from "@/modules/payroll/structures.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { setComponentActiveAction } from "../actions";
import { ComponentForm } from "../payroll-forms";
import { PayrollTabs } from "../payroll-tabs";

export const metadata = { title: "Salary components" };

export default async function ComponentsPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "payroll.read") && !hasPermission(ctx, "salary.structure.manage")) return <NotPermitted />;
  const canManage = hasPermission(ctx, "salary.structure.manage");
  const rows = await listComponents(ctx, { includeInactive: true });
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="Payroll"
        description="Salary components are the school's own earnings and deductions. Nothing is pre-filled and nothing is calculated by law automatically: enter PF, professional tax and similar items with your own values."
      />
      <PayrollTabs current="components" />
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Add a component</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ComponentForm defaults={{ code: "", name: "", kind: "EARNING", calc: "FIXED", prorated: true }} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Components</h2>
          </CardTitle>
          <CardDescription>{rows.length === 0 ? "No components yet." : `${rows.length} component${rows.length === 1 ? "" : "s"}.`}</CardDescription>
        </CardHeader>
        {rows.length > 0 && (
          <CardContent>
            <ul className="grid gap-3">
              {rows.map((c) => (
                <li key={c.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-medium">
                      {c.name} <span className="font-mono text-xs text-muted-foreground">{c.code}</span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <Badge variant={c.kind === "EARNING" ? "default" : "outline"}>{c.kind === "EARNING" ? "Earning" : "Deduction"}</Badge>
                      <Badge variant="secondary">{c.calc === "FIXED" ? "Fixed ₹" : "% of basic"}</Badge>
                      {!c.prorated && <Badge variant="secondary">Not reduced for unpaid days</Badge>}
                      {!c.isActive && <Badge variant="secondary">Inactive</Badge>}
                    </span>
                  </div>
                  {canManage && (
                    <div className="grid gap-2">
                      <details className="rounded-lg border p-3">
                        <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Edit {c.name}</summary>
                        <div className="mt-3">
                          <ComponentForm idPrefix="e" defaults={{ id: c.id, version: c.version, code: c.code, name: c.name, kind: c.kind, calc: c.calc, prorated: c.prorated, locked: c._count.items > 0 }} />
                        </div>
                      </details>
                      <ConfirmAction
                        label={c.isActive ? "Deactivate" : "Activate"}
                        icon={c.isActive ? <CircleOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                        variant={c.isActive ? "destructive" : undefined}
                        title={`${c.isActive ? "Deactivate" : "Activate"} ${c.name}?`}
                        description={c.isActive ? "It can't be added to structures any more. Structures that already have it keep it." : "It can be added to structures again."}
                        confirmLabel={c.isActive ? "Deactivate" : "Activate"}
                        action={setComponentActiveAction}
                        fields={{ id: c.id, version: String(c.version), active: c.isActive ? "false" : "true" }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
