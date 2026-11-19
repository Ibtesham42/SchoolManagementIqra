import Decimal from "decimal.js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly, todayInTimeZone } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { getSlip } from "@/modules/payroll/slips.service";
import { idField } from "@/modules/students/person.schemas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { PageHeader } from "@/components/erp/page-header";
import { removeAdjustmentAction } from "../../actions";
import { AddAdjustmentForm, RecordPaymentForm } from "../slip-forms";

export const metadata = { title: "Salary slip" };

const ADJ = { BONUS: "Bonus", ARREARS: "Arrears", OTHER_EARNING: "Other earning", OTHER_DEDUCTION: "Other deduction" } as const;
const METHOD: Record<string, string> = { BANK_TRANSFER: "Bank transfer", UPI: "UPI", CHEQUE: "Cheque", CASH: "Cash" };
type Line = { code: string; name: string; amount: string };
const lines = (v: unknown): Line[] => (Array.isArray(v) ? (v as Line[]).filter((l) => l && typeof l.name === "string") : []);

export default async function SlipPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  const parsed = idField.safeParse((await params).id);
  if (!parsed.success) notFound();
  const slip = await getSlip(ctx, parsed.data).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const month = slip.run.month.toISOString().slice(0, 7);
  const paid = slip.payments.reduce((t, p) => t.plus(p.amount.toString()), new Decimal(0));
  const due = new Decimal(slip.net.toString()).minus(paid);
  const today = todayInTimeZone(await getSchoolTimezone());
  const canAdjust = hasPermission(ctx, "payroll.prepare") && slip.run.status === "PREPARED" && !slip.own;
  const canPay = hasPermission(ctx, "payroll.pay") && (slip.run.status === "APPROVED" || slip.run.status === "PAID") && !slip.own && due.gt(0);
  const back = hasPermission(ctx, "payroll.read") ? `/erp/payroll/runs/${slip.run.id}` : "/erp/payroll/my-slips";
  const earnAdj = slip.adjustments.filter((a) => a.kind !== "OTHER_DEDUCTION");
  const dedAdj = slip.adjustments.filter((a) => a.kind === "OTHER_DEDUCTION");

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader
        title={`Salary slip ${month}`}
        description={`${slip.employee.fullName} · ${slip.employee.employeeCode} · ${slip.employee.designation.name} · ${slip.employee.department.name}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {(slip.run.status === "APPROVED" || slip.run.status === "PAID") && (
              <a href={`/api/v1/payroll/slips/${slip.id}/pdf`} className="flex min-h-11 items-center rounded-lg border px-3 text-sm" target="_blank" rel="noopener">
                Download PDF
              </a>
            )}
            <Link href={back} className="flex min-h-11 items-center rounded-lg border px-3 text-sm">
              Back
            </Link>
          </div>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="flex flex-wrap items-center gap-2">
              Net ₹{slip.net.toFixed(2)} {slip.slipNo && <Badge variant="outline">{slip.slipNo}</Badge>}
            </h2>
          </CardTitle>
          <CardDescription>
            Paid days {slip.paidDays.toString()} of {slip.monthDays} ({slip.dayBasis === "WORKING_DAYS" ? "working days" : "calendar days"}) · loss of pay {slip.lopDays.toString()}
            {slip.offRollsDays > 0 ? ` · not on the rolls ${slip.offRollsDays}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <section aria-labelledby="earn-h" className="grid gap-1 text-sm">
            <h3 id="earn-h" className="font-medium">Earnings</h3>
            {lines(slip.earnings).map((l) => (
              <p key={l.code} className="flex justify-between gap-2">
                <span>{l.name}</span>
                <span className="tabular-nums">₹{l.amount}</span>
              </p>
            ))}
            {earnAdj.map((a) => (
              <p key={a.id} className="flex justify-between gap-2">
                <span>
                  {ADJ[a.kind]}: {a.note}
                </span>
                <span className="tabular-nums">₹{a.amount.toFixed(2)}</span>
              </p>
            ))}
            <p className="flex justify-between gap-2 border-t pt-1 font-medium">
              <span>Gross</span>
              <span className="tabular-nums">₹{slip.gross.toFixed(2)}</span>
            </p>
          </section>
          <section aria-labelledby="ded-h" className="grid gap-1 text-sm">
            <h3 id="ded-h" className="font-medium">Deductions</h3>
            {lines(slip.deductions).map((l) => (
              <p key={l.code} className="flex justify-between gap-2">
                <span>{l.name}</span>
                <span className="tabular-nums">₹{l.amount}</span>
              </p>
            ))}
            {dedAdj.map((a) => (
              <p key={a.id} className="flex justify-between gap-2">
                <span>{a.note}</span>
                <span className="tabular-nums">₹{a.amount.toFixed(2)}</span>
              </p>
            ))}
            <p className="flex justify-between gap-2 border-t pt-1 font-medium">
              <span>Total deductions</span>
              <span className="tabular-nums">₹{slip.totalDeductions.toFixed(2)}</span>
            </p>
          </section>
        </CardContent>
      </Card>

      {(canAdjust || (slip.adjustments.length > 0 && slip.run.status === "PREPARED" && hasPermission(ctx, "payroll.prepare"))) && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Adjustments</h2>
            </CardTitle>
            <CardDescription>Bonus, arrears and one-off items. They are applied when the payroll is prepared again.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {slip.adjustments.length > 0 && (
              <ul className="grid gap-2">
                {slip.adjustments.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                    <span>
                      {ADJ[a.kind]} · ₹{a.amount.toFixed(2)} · {a.note}
                    </span>
                    {canAdjust && (
                      <ConfirmAction
                        label="Remove"
                        icon={<Trash2 aria-hidden="true" />}
                        variant="destructive"
                        title="Remove this adjustment?"
                        description="Prepare the payroll again to apply the change."
                        confirmLabel="Remove"
                        action={removeAdjustmentAction}
                        fields={{ id: a.id }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canAdjust && <AddAdjustmentForm slipId={slip.id} />}
          </CardContent>
        </Card>
      )}

      {(slip.run.status === "APPROVED" || slip.run.status === "PAID") && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Payments</h2>
            </CardTitle>
            <CardDescription>{due.gt(0) ? `₹${due.toFixed(2)} still due.` : "Fully paid."}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {slip.payments.length > 0 && (
              <ul className="grid gap-2">
                {slip.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap justify-between gap-2 rounded-lg border p-3 text-sm">
                    <span>
                      {formatDateOnly(p.paidOn)} · {METHOD[p.method] ?? p.method}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </span>
                    <span className="tabular-nums">₹{p.amount.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
            {canPay && <RecordPaymentForm slipId={slip.id} due={due.toFixed(2)} today={today} />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
