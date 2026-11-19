import { CheckCircle2, CircleOff } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { listComponents, listStructures } from "@/modules/payroll/structures.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { setStructureActiveAction } from "../actions";
import { StructureForm } from "../payroll-forms";
import { PayrollTabs } from "../payroll-tabs";

export const metadata = { title: "Salary structures" };

export default async function StructuresPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "payroll.read") && !hasPermission(ctx, "salary.structure.manage")) return <NotPermitted />;
  const canManage = hasPermission(ctx, "salary.structure.manage");
  const [structures, components] = await Promise.all([listStructures(ctx, { includeInactive: true }), canManage ? listComponents(ctx) : Promise.resolve([])]);
  const options = components.map((c) => ({ id: c.id, label: `${c.name} (${c.code}) · ${c.kind === "EARNING" ? "earning" : "deduction"}`, calc: c.calc }));
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="Payroll"
        description="A salary structure groups components with their amounts or percentages of basic. Each employee's basic and structure are set (and approved) per employee."
      />
      <PayrollTabs current="structures" />
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Add a structure</h2>
            </CardTitle>
            <CardDescription>{options.length === 0 ? "Add salary components first." : "Only active components are offered."}</CardDescription>
          </CardHeader>
          {options.length > 0 && (
            <CardContent>
              <StructureForm defaults={{ name: "", items: [] }} components={options} />
            </CardContent>
          )}
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Structures</h2>
          </CardTitle>
          <CardDescription>{structures.length === 0 ? "No structures yet." : `${structures.length} structure${structures.length === 1 ? "" : "s"}.`}</CardDescription>
        </CardHeader>
        {structures.length > 0 && (
          <CardContent>
            <ul className="grid gap-3">
              {structures.map((s) => (
                <li key={s.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-medium">{s.name}</span>
                    <span className="flex flex-wrap gap-1">
                      <Badge variant="outline">{s._count.salaries} employee(s)</Badge>
                      {!s.isActive && <Badge variant="secondary">Inactive</Badge>}
                    </span>
                  </div>
                  {s.items.length === 0 ? (
                    <p className="text-muted-foreground">Basic only.</p>
                  ) : (
                    <ul className="grid gap-1">
                      {s.items.map((it) => (
                        <li key={it.component.id} className="flex flex-wrap justify-between gap-2">
                          <span>
                            {it.component.name} <span className="text-xs text-muted-foreground">({it.component.kind === "EARNING" ? "earning" : "deduction"})</span>
                          </span>
                          <span className="tabular-nums">{it.component.calc === "FIXED" ? `₹${it.value.toFixed(2)}` : `${it.value.toFixed(2)} % of basic`}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {canManage && (
                    <div className="grid gap-2">
                      <details className="rounded-lg border p-3">
                        <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Edit {s.name}</summary>
                        <div className="mt-3">
                          <StructureForm
                            idPrefix="e"
                            components={options}
                            defaults={{ id: s.id, version: s.version, name: s.name, items: s.items.map((it) => ({ componentId: it.component.id, value: it.value.toFixed(2) })) }}
                          />
                        </div>
                      </details>
                      <ConfirmAction
                        label={s.isActive ? "Deactivate" : "Activate"}
                        icon={s.isActive ? <CircleOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                        variant={s.isActive ? "destructive" : undefined}
                        title={`${s.isActive ? "Deactivate" : "Activate"} ${s.name}?`}
                        description={s.isActive ? "It can't be given to employees any more. Employees already on it keep it." : "It can be given to employees again."}
                        confirmLabel={s.isActive ? "Deactivate" : "Activate"}
                        action={setStructureActiveAction}
                        fields={{ id: s.id, version: String(s.version), active: s.isActive ? "false" : "true" }}
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
