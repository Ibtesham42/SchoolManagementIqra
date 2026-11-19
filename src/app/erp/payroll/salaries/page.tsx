import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { formatDate } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { listPayrollEmployees, listPendingSalaries } from "@/modules/payroll/salaries.service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { PayrollTabs } from "../payroll-tabs";
import { DecideSalaryForm } from "./salary-forms";

export const metadata = { title: "Employee salaries" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const month = (d: Date) => d.toISOString().slice(0, 7);

export default async function SalariesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "payroll.read")) return <NotPermitted />;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 60) : "";
  const canApprove = hasPermission(ctx, "payroll.approve");
  const [employees, pending] = await Promise.all([listPayrollEmployees(ctx, q), canApprove ? listPendingSalaries(ctx) : Promise.resolve([])]);
  const linked = (typeof ctx.employeeId === "string" && ctx.employeeId !== "") || ctx.isSuperAdmin;

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Payroll" description="Each employee's basic and salary structure. HR proposes; a payroll approver approves. Approved salaries are never edited — a change is a new proposal." />
      <PayrollTabs current="salaries" showSalaries />
      {canApprove && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Waiting for approval</h2>
            </CardTitle>
            <CardDescription>{pending.length === 0 ? "Nothing to approve." : `${pending.length} proposal(s) from other staff. You can't decide your own salary or one you proposed.`}</CardDescription>
          </CardHeader>
          {pending.length > 0 && (
            <CardContent>
              <ul className="grid gap-3">
                {pending.map((p) => (
                  <li key={p.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap justify-between gap-2">
                      <Link href={`/erp/payroll/salaries/${p.employee.id}`} className="font-medium underline-offset-2 hover:underline">
                        {p.employee.fullName} <span className="font-mono text-xs text-muted-foreground">{p.employee.employeeCode}</span>
                      </Link>
                      <span className="tabular-nums">₹{p.basic.toFixed(2)} basic</span>
                    </div>
                    <p className="text-muted-foreground">
                      {p.structure.name} · from {month(p.effectiveFrom)} · proposed by {p.proposedBy?.displayName ?? "—"} on {formatDate(p.createdAt)}
                    </p>
                    {linked ? (
                      <details className="rounded-lg border p-3">
                        <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Decide</summary>
                        <div className="mt-3">
                          <DecideSalaryForm id={p.id} version={p.version} idPrefix="q" />
                        </div>
                      </details>
                    ) : (
                      <p className="text-xs text-muted-foreground">Your login isn&apos;t linked to your staff record, so you can&apos;t decide. Ask a Super Admin to link it.</p>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          )}
        </Card>
      )}
      <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="grid flex-1 gap-1.5 text-sm font-medium" htmlFor="sal-q">
          Find staff
          <input id="sal-q" name="q" defaultValue={q} placeholder="Name or employee ID" className={FIELD} />
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Search
        </Button>
      </form>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Staff</h2>
          </CardTitle>
          <CardDescription>{employees.length === 0 ? "No staff found." : `${employees.length}${employees.length === 50 ? "+" : ""} shown.`}</CardDescription>
        </CardHeader>
        {employees.length > 0 && (
          <CardContent>
            <ul className="grid gap-2">
              {employees.map((e) => {
                const approved = e.salaries.find((s) => s.status === "APPROVED");
                const pendingOne = e.salaries.some((s) => s.status === "PROPOSED");
                return (
                  <li key={e.id}>
                    <Link href={`/erp/payroll/salaries/${e.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm hover:bg-muted">
                      <span>
                        <span className="font-medium">{e.fullName}</span> <span className="font-mono text-xs text-muted-foreground">{e.employeeCode}</span>
                        <span className="block text-xs text-muted-foreground">{e.designation.name}</span>
                      </span>
                      <span className="flex gap-1">
                        {approved ? <Badge variant="outline">Salary from {month(approved.effectiveFrom)}</Badge> : <Badge variant="secondary">No salary yet</Badge>}
                        {pendingOne && <Badge>Pending</Badge>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
