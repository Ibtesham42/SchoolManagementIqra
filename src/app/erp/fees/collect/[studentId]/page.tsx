import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { formatIndianMoney } from "@/lib/money";
import { getCounterView } from "@/modules/fees/collection.service";
import { holdsAll } from "@/modules/fees/fees.policy";
import { idField } from "@/modules/students/person.schemas";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { CollectForm } from "../../collect-forms";
import { FeesTabs } from "../../fees-tabs";

export const metadata = { title: "Collect fees" };

export default async function CollectStudentPage({ params }: { params: Promise<{ studentId: string }> }) {
  const ctx = await requireAuth();
  if (!holdsAll(ctx, "fee.collect")) return <NotPermitted />;
  const id = idField.safeParse((await params).studentId);
  if (!id.success) notFound();
  const view = await getCounterView(ctx, id.data).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  // FC15: a fresh key each time the form is rendered; the same key twice gives one receipt.
  const idempotencyKey = randomUUID();
  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <PageHeader title={view.student.fullName} description={`${view.student.studentCode} · ${view.student.className} ${view.student.sectionCode}`} />
      <FeesTabs current="collect" />
      <p className="text-sm">
        <Link href="/erp/fees/collect" className="underline">
          Another student
        </Link>
        {" · "}
        <Link href={`/erp/fees/students/${view.student.studentId}`} className="underline">
          Fee ledger
        </Link>
      </p>
      {!view.receiptFormatSet && (
        <Alert variant="destructive">
          <AlertDescription>The receipt number format isn&apos;t set, so payments can&apos;t be recorded yet (Fees → Fee heads).</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Due today: ₹{formatIndianMoney(view.totalDue)}</h2>
          </CardTitle>
          <CardDescription>Oldest first; late fees are worked out for today and fixed when paid.</CardDescription>
        </CardHeader>
        <CardContent>
          {view.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing to pay.</p>
          ) : (
            <ul className="grid gap-2">
              {view.invoices.map((i) => (
                <li key={i.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {i.sessionName} · {i.installmentName}
                    </span>
                    <span className="tabular-nums">₹{formatIndianMoney(i.balance)}</span>
                  </div>
                  <p className="text-muted-foreground">
                    {i.invoiceNo} · due {formatDateOnly(new Date(`${i.dueOn}T00:00:00.000Z`))}
                    {i.lateFee !== "0.00" && ` · late fee ₹${formatIndianMoney(i.lateFee)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {view.recentReceipts.length > 0 && (
        <Alert>
          <AlertDescription>
            Receipts for this student in the last 24 hours:{" "}
            {view.recentReceipts.map((r, i) => (
              <span key={r.id}>
                {i > 0 && "; "}
                <Link href={`/erp/fees/receipts/${r.id}`} className="underline">
                  {r.receiptNo}
                </Link>{" "}
                (₹{formatIndianMoney(r.amount)}, {r.method}
                {r.collectedBy ? `, ${r.collectedBy}` : ""}
                {r.cancelled ? ", cancelled" : ""})
              </span>
            ))}
            . Check you are not collecting the same money twice.
          </AlertDescription>
        </Alert>
      )}
      {view.invoices.length > 0 && view.receiptFormatSet && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Record a payment</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CollectForm
              studentId={view.student.studentId}
              idempotencyKey={idempotencyKey}
              today={view.today}
              earliest={view.earliestDate}
              totalDue={view.totalDue}
              canWaive={view.canWaiveLateFee}
              invoices={view.invoices.map((i) => ({ id: i.id, label: `${i.invoiceNo} · ${i.installmentName} (₹${formatIndianMoney(i.balance)})`, lateFee: i.lateFee }))}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
