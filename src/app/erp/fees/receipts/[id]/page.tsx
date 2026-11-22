import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly, formatDateTime } from "@/lib/format";
import { formatIndianMoney } from "@/lib/money";
import { canReadFees, canReadReceipts } from "@/modules/fees/fees.policy";
import { getReceipt } from "@/modules/fees/receipts.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { idField } from "@/modules/students/person.schemas";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { FeesTabs } from "../../fees-tabs";
import { CancelReceiptForm } from "../../receipt-forms";

export const metadata = { title: "Receipt" };

const dateOf = (s: string) => formatDateOnly(new Date(`${s}T00:00:00.000Z`));

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!canReadReceipts(ctx)) return <NotPermitted />;
  const id = idField.safeParse((await params).id);
  if (!id.success) notFound();
  const [r, tz] = await Promise.all([
    getReceipt(ctx, id.data).catch((e: unknown) => {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }),
    getSchoolTimezone(),
  ]);
  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <PageHeader title={`Receipt ${r.receiptNo}`} description={`${r.student.name} · ${r.student.studentCode} · ${r.student.className} ${r.student.sectionCode}`} />
      <FeesTabs current="receipts" />
      <p className="text-sm">
        <Link href="/erp/fees/receipts" className="underline">
          All receipts
        </Link>
        {canReadFees(ctx) && (
          <>
            {" · "}
            <Link href={`/erp/fees/students/${r.studentId}`} className="underline">
              Fee ledger
            </Link>
          </>
        )}
      </p>
      {r.cancelled && (
        <Alert variant="destructive">
          <AlertDescription>
            Cancelled{r.cancelledAt ? ` on ${formatDateTime(new Date(r.cancelledAt), tz)}` : ""}
            {r.cancelledBy ? ` by ${r.cancelledBy}` : ""}.{r.cancelReason ? ` Reason: ${r.cancelReason}` : ""} This receipt is not valid; its amount was put back on the invoices.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <h2>₹{formatIndianMoney(r.amount)}</h2>
            {r.cancelled ? <Badge variant="destructive">Cancelled</Badge> : <Badge variant="secondary">Valid</Badge>}
          </CardTitle>
          {r.amountInWords && <CardDescription>{r.amountInWords}</CardDescription>}
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            {/* A plain link (no prefetch): every open counts a print. */}
            <a href={`/api/v1/fees/receipts/${r.id}/pdf`} target="_blank" rel="noopener" className="inline-flex min-h-11 items-center rounded-lg border px-4 font-medium hover:bg-muted">
              {!r.printCounts ? "View office copy (PDF)" : r.printCount === 0 ? "Print receipt (PDF)" : "Print duplicate (PDF)"}
            </a>
            <span className="text-muted-foreground">{r.printCount === 0 ? "Not printed yet." : `Printed ${r.printCount} time${r.printCount === 1 ? "" : "s"}; further copies say DUPLICATE.`}</span>
          </div>
          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Paid on</dt>
            <dd>{dateOf(r.paidOn)}</dd>
            <dt className="text-muted-foreground">Method</dt>
            <dd>
              {r.method}
              {r.reference && <span className="font-mono"> · {r.reference}</span>}
              {r.bankName && ` · ${r.bankName}`}
              {r.instrumentDate && ` · cheque dated ${dateOf(r.instrumentDate)}`}
            </dd>
            <dt className="text-muted-foreground">Collected by</dt>
            <dd>
              {r.collectedBy ?? "—"} · recorded {formatDateTime(new Date(r.recordedAt), tz)}
            </dd>
          </dl>
          <div>
            <h3 className="mb-2 font-medium">Paid towards</h3>
            <ul className="grid gap-2">
              {r.lines.map((l, i) => (
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-3">
                  <span>
                    {l.description}
                    <span className="block text-xs text-muted-foreground">
                      {l.invoiceNo} · {l.session} · {l.installment}
                    </span>
                  </span>
                  <span className="tabular-nums">₹{formatIndianMoney(l.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
      {r.canCancel && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Cancel this receipt</h2>
            </CardTitle>
            <CardDescription>Only when the money was not received or was entered wrongly. Hand back cash or return the cheque outside the system.</CardDescription>
          </CardHeader>
          <CardContent>
            <CancelReceiptForm id={r.id} version={r.version} receiptNo={r.receiptNo} />
          </CardContent>
        </Card>
      )}
      {r.cancelBlockedReason && (
        <Alert>
          <AlertDescription>{r.cancelBlockedReason}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
