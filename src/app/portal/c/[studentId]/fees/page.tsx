import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { requirePortal } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { getPortalFeeLedger, type PortalInvoice } from "@/modules/fees/fees.portal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Fees" };

const day = (iso: string) => formatDateOnly(new Date(`${iso}T00:00:00Z`));
const rs = (v: string) => `Rs. ${v}`;

function InvoiceCard({ i }: { i: PortalInvoice }) {
  const open = i.status === "Due" || i.status === "Part paid";
  return (
    <Card className="py-3">
      <CardContent className="grid gap-2 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium">
            {i.installmentName} · {i.sessionName}
          </p>
          <Badge variant={i.overdue ? "destructive" : open ? "secondary" : "outline"}>{i.overdue ? "Overdue" : i.status}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {i.invoiceNo} · due {day(i.dueOn)}
        </p>
        <ul className="grid gap-1 text-sm">
          {i.lines.map((l, n) => (
            <li key={n} className="flex justify-between gap-3">
              <span>
                {l.label}
                {l.concession !== "0.00" && <span className="text-muted-foreground"> (concession {rs(l.concession)})</span>}
              </span>
              <span className="tabular-nums">{rs(l.amount)}</span>
            </li>
          ))}
        </ul>
        <div className="grid gap-0.5 border-t pt-2 text-sm">
          <p className="flex justify-between">
            <span>Total</span>
            <span className="tabular-nums">{rs(i.total)}</span>
          </p>
          <p className="flex justify-between">
            <span>Paid</span>
            <span className="tabular-nums">{rs(i.paid)}</span>
          </p>
          {open && (
            <p className="flex justify-between font-medium">
              <span>Still due{i.lateFeeToday !== "0.00" ? ` (+ late fee ${rs(i.lateFeeToday)} as of today)` : ""}</span>
              <span className="tabular-nums">{rs(i.balance)}</span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Phase 6B-M3 (P13) — the child's fees: what is due today (with the live late fee), invoices and receipts. */
export default async function PortalFeesPage({ params }: { params: Promise<{ studentId: string }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  const data = await getPortalFeeLedger(ctx, studentId).catch((e: unknown) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  });
  const open = data.invoices.filter((i) => i.status === "Due" || i.status === "Part paid");
  const settled = data.invoices.filter((i) => !(i.status === "Due" || i.status === "Part paid"));
  return (
    <div className="grid gap-4">
      <PageHeader title="Fees" description="Pay at the school office. Amounts include any late fee as of today." />
      <Card className="gap-1 py-4">
        <CardHeader className="px-4">
          <CardDescription>Due today</CardDescription>
          <CardTitle className="text-2xl tabular-nums">{rs(data.dueToday)}</CardTitle>
        </CardHeader>
      </Card>
      {data.overdueCount > 0 && (
        <Alert variant="destructive" role="status">
          <AlertDescription>
            {data.overdueCount} {data.overdueCount === 1 ? "payment is" : "payments are"} overdue. A late fee may be added until it is paid.
          </AlertDescription>
        </Alert>
      )}
      {open.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-lg font-semibold">Open</h2>
          {open.map((i) => (
            <InvoiceCard key={i.id} i={i} />
          ))}
        </section>
      )}
      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">Receipts</h2>
        {data.receipts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payments yet.</p>
        ) : (
          <ul className="grid gap-2">
            {data.receipts.map((r) => (
              <li key={r.id}>
                <Card className="py-3">
                  <CardContent className="flex flex-col gap-2 px-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-medium tabular-nums">
                        {rs(r.amount)} · {r.method}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {r.receiptNo} · {day(r.paidOn)}
                      </p>
                      {r.cancelled && <Badge variant="secondary">Cancelled</Badge>}
                    </div>
                    <Button asChild variant="outline" className="w-full sm:w-auto">
                      <a href={`/api/v1/portal/receipts/${encodeURIComponent(r.id)}/pdf`} download>
                        <Download aria-hidden="true" />
                        Receipt (PDF)
                      </a>
                    </Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
      {settled.length > 0 && (
        <details className="grid gap-2">
          <summary className="flex min-h-11 cursor-pointer items-center text-lg font-semibold">Paid and settled ({settled.length})</summary>
          <div className="mt-2 grid gap-2">
            {settled.map((i) => (
              <InvoiceCard key={i.id} i={i} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
