import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly, formatDateTime } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { canDecideClaims, listPaymentClaims } from "@/modules/fees/payment-claims.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { FeesTabs } from "../fees-tabs";
import { confirmClaimAction } from "./actions";
import { RejectClaimForm } from "./reject-form";

export const metadata = { title: "UPI claims" };

const day = (iso: string) => formatDateOnly(new Date(`${iso}T00:00:00Z`));

/**
 * Phase 6C-M3 (P19) — parents' UPI / bank-transfer claims. Match each against the bank statement, then confirm (an
 * ordinary receipt is issued for the amount, oldest dues first) or reject with a reason.
 */
export default async function ClaimsPage() {
  const ctx = await requireAuth();
  if (!canDecideClaims(ctx)) return <NotPermitted />;
  const [{ waiting, decided }, tz] = await Promise.all([listPaymentClaims(ctx), getSchoolTimezone()]);
  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader title="UPI claims" description="Payments parents reported from the portal. Check each one against the bank statement before you confirm it." />
      <FeesTabs current="claims" />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Waiting ({waiting.length})</h2>
          </CardTitle>
          <CardDescription>Oldest first. Confirming issues the receipt in your name.</CardDescription>
        </CardHeader>
        <CardContent>
          {waiting.length === 0 ? (
            <p className="text-sm text-muted-foreground">No claims waiting.</p>
          ) : (
            <ul className="grid gap-3">
              {waiting.map((c) => (
                <li key={c.id} className="grid gap-3 rounded-lg border p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {c.student.fullName} <span className="text-sm text-muted-foreground">({c.student.studentCode})</span>
                    </span>
                    <span className="text-lg font-semibold tabular-nums">Rs. {c.amount}</span>
                  </div>
                  <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
                    <dt className="text-muted-foreground">Method</dt>
                    <dd>{c.method}</dd>
                    <dt className="text-muted-foreground">Reference</dt>
                    <dd className="font-mono break-all select-all">{c.transactionRef}</dd>
                    <dt className="text-muted-foreground">Paid on</dt>
                    <dd>{day(c.paidOn)}</dd>
                    <dt className="text-muted-foreground">Reported</dt>
                    <dd>
                      {formatDateTime(c.createdAt, tz)}
                      {c.submittedBy ? ` by ${c.submittedBy}` : ""}
                    </dd>
                  </dl>
                  {c.mine ? (
                    <p className="text-sm text-muted-foreground">You reported this payment, so someone else must decide it.</p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-start">
                      <ConfirmAction
                        label="Confirm"
                        icon={<CheckCircle2 aria-hidden="true" />}
                        title={`Confirm Rs. ${c.amount} for ${c.student.fullName}?`}
                        description={`Only if reference ${c.transactionRef} is on the bank statement for this amount, from this family (check the remitter and the note "Fees ${c.student.studentCode}"). A receipt is issued in your name; the money goes to the oldest dues first.`}
                        confirmLabel="Confirm and issue receipt"
                        action={confirmClaimAction}
                        fields={{ id: c.id, version: String(c.version) }}
                      />
                      <details className="rounded-lg border p-3 open:pb-4">
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Reject…</summary>
                        <div className="mt-3">
                          <RejectClaimForm id={c.id} version={c.version} />
                        </div>
                      </details>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Recently decided</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {decided.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="grid gap-2">
              {decided.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
                  <span>
                    {c.student.fullName} · Rs. {c.amount} · {c.method} · <span className="font-mono">{c.transactionRef}</span>
                    {c.decidedAt ? ` · ${formatDateTime(c.decidedAt, tz)}` : ""}
                    {c.decidedBy ? ` by ${c.decidedBy}` : ""}
                    {c.status === "REJECTED" && c.rejectReason ? <span className="block text-muted-foreground">Reason: {c.rejectReason}</span> : null}
                  </span>
                  {c.status === "CONFIRMED" && c.receipt ? (
                    <Link href={`/erp/fees/receipts/${encodeURIComponent(c.receipt.id)}`} className="underline">
                      <Badge>Receipt {c.receipt.receiptNo}</Badge>
                    </Link>
                  ) : (
                    <Badge variant="destructive">Rejected</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
