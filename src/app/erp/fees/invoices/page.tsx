import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { formatIndianMoney } from "@/lib/money";
import { feeAccess } from "@/modules/fees/fees.policy";
import { listInvoices, previewInvoices } from "@/modules/fees/invoices.service";
import { feeSetupOptions, listFeeInstallments } from "@/modules/fees/setup.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { FeesTabs, pickSession } from "../fees-tabs";
import { CancelInvoiceForm, IssueForm } from "../invoice-forms";

export const metadata = { title: "Invoices" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const STATUS = { ISSUED: "Unpaid", PARTIAL: "Part paid", PAID: "Paid", WAIVED: "Nothing to pay", CANCELLED: "Cancelled" } as const;

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const access = feeAccess(ctx);
  if (!access.setup) return <NotPermitted />;
  const sp = await searchParams;
  const { sessions, classes } = await feeSetupOptions(ctx);
  const session = pickSession(sessions, sp.session);
  const installments = session ? await listFeeInstallments(ctx, session.id) : [];
  const cls = classes.find((c) => c.id === sp.class);
  const inst = installments.find((i) => i.id === sp.installment);
  const writable = access.manageSetup && session !== undefined && session.status !== "CLOSED";
  let preview: Awaited<ReturnType<typeof previewInvoices>> | null = null;
  let previewProblem: string | null = null;
  if (session && cls && inst && writable) {
    preview = await previewInvoices(ctx, { academicSessionId: session.id, classId: cls.id, installmentId: inst.id }).catch((e: unknown) => {
      if (e instanceof ConflictError || e instanceof NotFoundError) {
        previewProblem = e.message;
        return null;
      }
      throw e;
    });
  }
  const invoices = session && inst ? await listInvoices(ctx, { academicSessionId: session.id, installmentId: inst.id, classId: cls?.id }) : [];
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Fees" description="Invoices are made per class and installment from the class's active fees, with approved concessions and extra charges. Running it again only adds students who don't have the invoice yet." />
      <FeesTabs current="invoices" session={session?.id} />
      {!session ? (
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      ) : (
        <>
          <form method="get" action="/erp/fees/invoices" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="inv-session">
              Session
              <select id="inv-session" name="session" defaultValue={session.id} className={FIELD}>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="inv-class">
              Class
              <select id="inv-class" name="class" defaultValue={cls?.id ?? ""} className={FIELD}>
                <option value="">All classes</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="inv-inst">
              Installment
              <select id="inv-inst" name="installment" defaultValue={inst?.id ?? ""} className={FIELD} required>
                <option value="">Choose…</option>
                {installments.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="min-h-11 rounded-lg border px-4 text-sm font-medium hover:bg-muted">
              Show
            </button>
          </form>

          {writable && cls && inst && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>
                    Issue {inst.name} invoices for {cls.name}
                  </h2>
                </CardTitle>
                {preview && (
                  <CardDescription>
                    From {preview.structure.name}. {preview.counts.toIssue} to issue · {preview.counts.alreadyInvoiced} already invoiced · {preview.counts.notBillable} not billed for this installment (joined later or left)
                    {preview.counts.nothingToBill > 0 ? ` · ${preview.counts.nothingToBill} with nothing to pay` : ""}.
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="grid gap-3">
                {previewProblem && (
                  <p role="alert" className="text-sm text-destructive">
                    {previewProblem}
                  </p>
                )}
                {preview && preview.rows.length > 0 && (
                  <>
                    <ul className="grid gap-1 text-sm">
                      {preview.rows.map((r) => (
                        <li key={r.studentId} className="flex flex-wrap justify-between gap-2 rounded-lg border p-2">
                          <span>
                            {r.fullName} <span className="text-muted-foreground">({r.studentCode}, {r.sectionCode})</span>
                          </span>
                          <span className="tabular-nums">
                            ₹{formatIndianMoney(r.total)}
                            {r.concession !== "0.00" && <span className="text-muted-foreground"> (after ₹{formatIndianMoney(r.concession)} concession)</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <IssueForm sessionId={session.id} classId={cls.id} installmentId={inst.id} count={preview.counts.toIssue} total={formatIndianMoney(preview.total)} rawTotal={preview.total} structureId={preview.structure.id} />
                  </>
                )}
                {preview && preview.rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing to issue.</p>}
              </CardContent>
            </Card>
          )}

          {inst && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>
                    {inst.name} invoices{cls ? ` · ${cls.name}` : ""} ({invoices.length})
                  </h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {invoices.some((i) => i.notReissued) && (
                  <p role="status" className="rounded-lg border border-amber-500/50 p-3 text-sm">
                    {invoices.filter((i) => i.notReissued).length} cancelled invoice{invoices.filter((i) => i.notReissued).length === 1 ? " has" : "s have"} not been issued again. Run the issue for this class to bill them.
                  </p>
                )}
                {invoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No invoices yet.</p>
                ) : (
                  <ul className="grid gap-2">
                    {invoices.map((i) => (
                      <li key={i.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <Link href={`/erp/fees/students/${i.studentId}`} className="font-medium underline">
                            {i.fullName}
                          </Link>
                          <Badge variant={i.status === "PAID" ? "default" : "secondary"}>{STATUS[i.status]}</Badge>
                        </div>
                        <p className="text-muted-foreground">
                          {i.invoiceNo} · {i.studentCode}, {i.sectionCode} · ₹{formatIndianMoney(i.total)}
                          {i.paid !== "0.00" ? ` · paid ₹${formatIndianMoney(i.paid)}` : ""}
                        </p>
                        {writable && !i.cancelled && i.paid === "0.00" && (
                          <details className="rounded-lg border p-3">
                            <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Cancel {i.invoiceNo}</summary>
                            <div className="mt-3">
                              <CancelInvoiceForm id={i.id} version={i.version} />
                            </div>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
