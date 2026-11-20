import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { formatIndianMoney } from "@/lib/money";
import { canReadFees } from "@/modules/fees/fees.policy";
import { getStudentFeeLedger } from "@/modules/fees/invoices.service";
import { idField } from "@/modules/students/person.schemas";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { FeesTabs } from "../../fees-tabs";

export const metadata = { title: "Student fees" };

const STATUS = { ISSUED: "Unpaid", PARTIAL: "Part paid", PAID: "Paid", WAIVED: "Nothing to pay", CANCELLED: "Cancelled" } as const;
const KIND = { STRUCTURE: "", CHARGE: " (extra)", LATE_FEE: " (late fee)", OPENING_BALANCE: " (previous dues)" } as const;

export default async function StudentFeesPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!canReadFees(ctx)) return <NotPermitted />;
  const id = idField.safeParse((await params).id);
  if (!id.success) notFound();
  const ledger = await getStudentFeeLedger(ctx, id.data).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title={ledger.student ? `${ledger.student.fullName}: fees` : "Student fees"} description={ledger.student ? `${ledger.student.studentCode} · ${ledger.student.className} ${ledger.student.sectionCode}` : undefined} />
      <FeesTabs current="invoices" />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Balance due: ₹{formatIndianMoney(ledger.balance)}</h2>
          </CardTitle>
          <CardDescription>All sessions, oldest due first. Cancelled invoices are listed but not counted.</CardDescription>
        </CardHeader>
        <CardContent>
          {ledger.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <ul className="grid gap-3">
              {ledger.invoices.map((i) => (
                <li key={i.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {i.sessionName} · {i.installmentName}
                    </span>
                    <Badge variant={i.status === "PAID" ? "default" : "secondary"}>{STATUS[i.status]}</Badge>
                  </div>
                  <p className="text-muted-foreground">
                    {i.invoiceNo} · due {formatDateOnly(new Date(`${i.dueOn}T00:00:00.000Z`))}
                  </p>
                  <ul className="grid gap-1">
                    {i.items.map((it) => (
                      <li key={it.id} className="flex flex-wrap justify-between gap-2">
                        <span>
                          {it.description}
                          {KIND[it.kind]}
                        </span>
                        <span className="tabular-nums">
                          ₹{formatIndianMoney(it.amount)}
                          {it.concession !== "0.00" && <span className="text-muted-foreground"> − ₹{formatIndianMoney(it.concession)}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="flex flex-wrap justify-between gap-2 border-t pt-2 font-medium tabular-nums">
                    <span>Total ₹{formatIndianMoney(i.total)}</span>
                    <span>{i.cancelled ? "Cancelled" : `Balance ₹${formatIndianMoney(i.balance)}`}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
