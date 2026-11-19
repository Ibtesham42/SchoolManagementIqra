import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { getRun } from "@/modules/payroll/runs.service";
import { idField } from "@/modules/students/person.schemas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { ApproveRunForm, PrepareRunForm, ReopenRunForm } from "../run-forms";
import { BulkPaymentForm } from "../../slips/slip-forms";
import { todayInTimeZone } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { RUN_STATUS } from "../run-status";

export const metadata = { title: "Monthly payroll" };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "payroll.read")) return <NotPermitted />;
  const parsed = idField.safeParse((await params).id);
  if (!parsed.success) notFound();
  const run = await getRun(ctx, parsed.data).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const month = run.month.toISOString().slice(0, 7);
  const canPrepare = hasPermission(ctx, "payroll.prepare") && (run.status === "DRAFT" || run.status === "PREPARED");
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader
        title={`Payroll ${month}`}
        description={run.dayBasis ? `Prorated on ${run.dayBasis === "WORKING_DAYS" ? "working days" : "calendar days"}.` : "Not prepared yet."}
        actions={
          <Link href="/erp/payroll/runs" className="flex min-h-11 items-center rounded-lg border px-3 text-sm">
            All months
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="flex flex-wrap items-center gap-2">
              {RUN_STATUS[run.status]} <Badge variant="outline">{run.employeeCount} slip(s)</Badge>
            </h2>
          </CardTitle>
          <CardDescription>
            {run.preparedAt ? `Prepared by ${run.preparedBy?.displayName ?? "—"} on ${formatDate(run.preparedAt)}.` : "Prepare it after the month ends and attendance is complete."}
            {run.approvedAt ? ` Approved by ${run.approvedBy?.displayName ?? "—"} on ${formatDate(run.approvedAt)}.` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {run.status !== "DRAFT" && (
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-lg border p-2">
                <dt className="text-xs text-muted-foreground">Gross</dt>
                <dd className="font-medium tabular-nums">₹{run.totalGross.toFixed(2)}</dd>
              </div>
              <div className="rounded-lg border p-2">
                <dt className="text-xs text-muted-foreground">Deductions</dt>
                <dd className="font-medium tabular-nums">₹{run.totalDeductions.toFixed(2)}</dd>
              </div>
              <div className="rounded-lg border p-2">
                <dt className="text-xs text-muted-foreground">Net</dt>
                <dd className="font-medium tabular-nums">₹{run.totalNet.toFixed(2)}</dd>
              </div>
            </dl>
          )}
          {canPrepare && <PrepareRunForm id={run.id} version={run.version} again={run.status === "PREPARED"} />}
          {run.status === "PREPARED" && hasPermission(ctx, "payroll.approve") && (
            <details className="rounded-lg border p-3">
              <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Approve</summary>
              <div className="mt-3">
                {run.preparedBy?.id === ctx.userId ? <p className="text-sm">You prepared this payroll, so someone else must approve it.</p> : <ApproveRunForm id={run.id} version={run.version} />}
              </div>
            </details>
          )}
          {run.status === "APPROVED" && hasPermission(ctx, "payroll.pay") && (
            <details className="rounded-lg border p-3">
              <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Record payment</summary>
              <div className="mt-3">
                <BulkPaymentForm runId={run.id} today={todayInTimeZone(await getSchoolTimezone())} />
              </div>
            </details>
          )}
          {run.status === "APPROVED" && hasPermission(ctx, "payroll.approve") && (
            <details className="rounded-lg border p-3">
              <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Reopen</summary>
              <div className="mt-3">
                <ReopenRunForm id={run.id} version={run.version} />
              </div>
            </details>
          )}
        </CardContent>
      </Card>
      {run.slips.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Slips</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <caption className="sr-only">Payroll slips for {month}</caption>
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-2 font-medium">Employee</th>
                    <th scope="col" className="px-2 py-2 font-medium">Slip</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Paid / month days</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">LOP</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Gross</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Deductions</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {run.slips.map((s) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        <Link href={`/erp/payroll/slips/${s.id}`} className="font-medium underline-offset-2 hover:underline">
                          {s.employee.fullName}
                        </Link>{" "}
                        <span className="font-mono text-xs text-muted-foreground">{s.employee.employeeCode}</span>
                      </th>
                      <td className="px-2 py-2 font-mono text-xs">{s.slipNo ?? "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {s.paidDays.toString()} / {s.monthDays}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{s.lopDays.toString()}</td>
                      <td className="px-2 py-2 text-right tabular-nums">₹{s.gross.toFixed(2)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">₹{s.totalDeductions.toFixed(2)}</td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums">₹{s.net.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="grid gap-2 md:hidden">
              {run.slips.map((s) => (
                <li key={s.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <Link href={`/erp/payroll/slips/${s.id}`} className="flex min-h-11 items-center font-medium">
                      {s.employee.fullName}
                    </Link>
                    <span className="font-medium tabular-nums">₹{s.net.toFixed(2)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {s.employee.employeeCode}{s.slipNo ? ` · ${s.slipNo}` : ""} · paid {s.paidDays.toString()} / {s.monthDays} days · LOP {s.lopDays.toString()} · gross ₹{s.gross.toFixed(2)} · deductions ₹{s.totalDeductions.toFixed(2)}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
