import Link from "next/link";
import { notFound } from "next/navigation";
import { XCircle } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDate, todayInTimeZone } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { getEmployeeSalaries } from "@/modules/payroll/salaries.service";
import { listStructures } from "@/modules/payroll/structures.service";
import { idField } from "@/modules/students/person.schemas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { withdrawSalaryAction } from "../../actions";
import { DecideSalaryForm, ProposeSalaryForm } from "../salary-forms";

export const metadata = { title: "Employee salary" };

const STATUS = { PROPOSED: "Pending", APPROVED: "Approved", REJECTED: "Rejected", WITHDRAWN: "Withdrawn" } as const;
const month = (d: Date) => d.toISOString().slice(0, 7);

export default async function EmployeeSalaryPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "payroll.read")) return <NotPermitted />;
  const parsed = idField.safeParse((await params).employeeId);
  if (!parsed.success) notFound();
  const data = await getEmployeeSalaries(ctx, parsed.data).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const canPropose = hasPermission(ctx, "salary.structure.manage");
  const canApprove = hasPermission(ctx, "payroll.approve");
  const linked = (typeof ctx.employeeId === "string" && ctx.employeeId !== "") || ctx.isSuperAdmin;
  const pending = data.history.find((h) => h.status === "PROPOSED");
  const structures = canPropose && !pending && !data.own ? await listStructures(ctx) : [];
  const today = todayInTimeZone(await getSchoolTimezone());
  const left = ["RESIGNED", "TERMINATED", "RETIRED"].includes(data.employee.employmentStatus);

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader
        title={data.employee.fullName}
        description={`${data.employee.employeeCode} · ${data.employee.designation.name} · ${data.employee.department.name}`}
        actions={
          <Link href="/erp/payroll/salaries" className="flex min-h-11 items-center rounded-lg border px-3 text-sm">
            All staff
          </Link>
        }
      />
      {data.own && <p className="rounded-lg border p-3 text-sm">This is your own salary. Someone else must propose and approve changes.</p>}
      {canPropose && !data.own && !pending && !left && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Propose a salary</h2>
            </CardTitle>
            <CardDescription>{structures.length === 0 ? "Add an active salary structure first." : "Applies from the first day of the chosen month, once approved."}</CardDescription>
          </CardHeader>
          {structures.length > 0 && linked && (
            <CardContent>
              <ProposeSalaryForm employeeId={data.employee.id} structures={structures.map((s) => ({ value: s.id, label: s.name }))} defaultMonth={today.slice(0, 7)} />
            </CardContent>
          )}
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Salary history</h2>
          </CardTitle>
          <CardDescription>{data.history.length === 0 ? "No salary yet." : "Newest first. Approved rows are never changed."}</CardDescription>
        </CardHeader>
        {data.history.length > 0 && (
          <CardContent>
            <ul className="grid gap-3">
              {data.history.map((h) => (
                <li key={h.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-medium tabular-nums">₹{h.basic.toFixed(2)} basic</span>
                    <Badge variant={h.status === "APPROVED" ? "default" : h.status === "PROPOSED" ? "outline" : "secondary"}>{STATUS[h.status]}</Badge>
                  </div>
                  <p className="text-muted-foreground">
                    {h.structure.name} · from {month(h.effectiveFrom)} · proposed by {h.proposedBy?.displayName ?? "—"} on {formatDate(h.createdAt)}
                    {h.decidedBy && h.decidedAt ? ` · decided by ${h.decidedBy.displayName} on ${formatDate(h.decidedAt)}` : ""}
                  </p>
                  {h.decisionNote && <p className="text-muted-foreground">Note: {h.decisionNote}</p>}
                  {h.status === "PROPOSED" && !data.own && linked && (
                    <div className="grid gap-2">
                      {canApprove && h.proposedBy?.id !== ctx.userId && (
                        <details className="rounded-lg border p-3">
                          <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Decide</summary>
                          <div className="mt-3">
                            <DecideSalaryForm id={h.id} version={h.version} idPrefix="h" />
                          </div>
                        </details>
                      )}
                      {canPropose && (
                        <ConfirmAction
                          label="Withdraw proposal"
                          icon={<XCircle aria-hidden="true" />}
                          variant="destructive"
                          title="Withdraw this proposal?"
                          description="It won't apply. HR can propose again."
                          confirmLabel="Withdraw"
                          action={withdrawSalaryAction}
                          fields={{ id: h.id, version: String(h.version) }}
                        />
                      )}
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
