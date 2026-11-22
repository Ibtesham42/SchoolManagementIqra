import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly } from "@/lib/format";
import { formatIndianMoney } from "@/lib/money";
import { canReadReceipts } from "@/modules/fees/fees.policy";
import { receiptListSchema } from "@/modules/fees/receipts.schemas";
import { listReceipts } from "@/modules/fees/receipts.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { FeesTabs } from "../fees-tabs";
import { ReceiptLookup } from "../receipt-forms";

export const metadata = { title: "Receipts" };

const dateOf = (s: string) => formatDateOnly(new Date(`${s}T00:00:00.000Z`));

function Status({ cancelled }: { cancelled: boolean }) {
  return cancelled ? <Badge variant="destructive">Cancelled</Badge> : <Badge variant="secondary">Valid</Badge>;
}

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!canReadReceipts(ctx)) return <NotPermitted />;
  const sp = await searchParams;
  const page = receiptListSchema.safeParse({ page: typeof sp.page === "string" ? sp.page : undefined });
  const current = page.success ? page.data.page : 1;
  const { receipts, hasMore } = await listReceipts(ctx, current);
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader title="Fees" description="Receipts issued at the counter, newest first. Open one to see or cancel it." />
      <FeesTabs current="receipts" />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Find a receipt</h2>
          </CardTitle>
          <CardDescription>Type the receipt number exactly as printed.</CardDescription>
        </CardHeader>
        <CardContent>
          <ReceiptLookup />
        </CardContent>
      </Card>
      {receipts.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">{current === 1 ? "No receipts yet." : "No more receipts."}</CardContent>
        </Card>
      ) : (
        <>
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt</TableHead>
                  <TableHead>Student</TableHead>
                  <TableHead>Paid on</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Collected by</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipts.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/erp/fees/receipts/${r.id}`} className="font-mono font-medium hover:underline">
                        {r.receiptNo}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {r.studentName}
                      <div className="text-xs text-muted-foreground">{r.studentCode}</div>
                    </TableCell>
                    <TableCell>{dateOf(r.paidOn)}</TableCell>
                    <TableCell>{r.method}</TableCell>
                    <TableCell className="text-right tabular-nums">₹{formatIndianMoney(r.amount)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.collectedBy ?? "—"}</TableCell>
                    <TableCell>
                      <Status cancelled={r.cancelled} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <ul className="grid gap-2 md:hidden">
            {receipts.map((r) => (
              <li key={r.id}>
                <Link href={`/erp/fees/receipts/${r.id}`} className="block rounded-xl border bg-background p-4 active:bg-muted">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono font-medium">{r.receiptNo}</p>
                      <p className="truncate text-sm">{r.studentName}</p>
                    </div>
                    <Status cancelled={r.cancelled} />
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    ₹{formatIndianMoney(r.amount)} · {r.method} · {dateOf(r.paidOn)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {(current > 1 || hasMore) && (
        <nav aria-label="Pages" className="flex justify-between gap-2">
          {current > 1 ? (
            <Link href={`/erp/fees/receipts?page=${current - 1}`} className="flex min-h-11 items-center rounded-lg border px-4 text-sm font-medium hover:bg-muted">
              Newer
            </Link>
          ) : (
            <span />
          )}
          {hasMore && (
            <Link href={`/erp/fees/receipts?page=${current + 1}`} className="flex min-h-11 items-center rounded-lg border px-4 text-sm font-medium hover:bg-muted">
              Older
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
