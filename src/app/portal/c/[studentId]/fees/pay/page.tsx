import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Smartphone } from "lucide-react";
import { requirePortal } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { getPortalPayPage } from "@/modules/fees/payment-claims.portal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";
import { ClaimForm } from "./claim-form";

export const metadata = { title: "Pay by UPI" };

const day = (iso: string) => formatDateOnly(new Date(`${iso}T00:00:00Z`));
const STATUS = {
  SUBMITTED: { label: "Waiting for the school", variant: "secondary" },
  CONFIRMED: { label: "Confirmed", variant: "default" },
  REJECTED: { label: "Not confirmed. Please contact the school office.", variant: "destructive" },
} as const;

/**
 * Phase 6C-M3 (P19) — pay in your own UPI app, then tell the school. No money passes through this site; the school's
 * Accountant confirms the payment against the bank statement and the receipt appears in the Fees tab.
 */
export default async function PortalPayPage({ params }: { params: Promise<{ studentId: string }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  const data = await getPortalPayPage(ctx, studentId).catch((e: unknown) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  });
  const fees = `/portal/c/${encodeURIComponent(studentId)}/fees`;
  const hasDue = data.dueToday !== "0.00";
  // upi:// opens the phone's UPI app with the school's ID, the amount and the Student ID as the note (no QR, no gateway).
  const upiLink = data.upi
    ? `upi://pay?pa=${encodeURIComponent(data.upi.vpa)}&pn=${encodeURIComponent(data.upi.payeeName)}&am=${encodeURIComponent(data.dueToday)}&cu=INR&tn=${encodeURIComponent(`Fees ${data.studentCode}`)}`
    : null;
  return (
    <div className="grid gap-4">
      <Link href={fees} className="inline-flex min-h-11 items-center gap-1 text-sm underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> Fees
      </Link>
      <PageHeader title="Pay by UPI" description={`For ${data.firstName}. Pay in your own UPI or bank app, then send the payment details below.`} />
      {!data.upi ? (
        <Alert>
          <AlertDescription>The school doesn&apos;t take UPI payments through the portal yet. Please pay at the school office.</AlertDescription>
        </Alert>
      ) : (
        <>
          <Card className="gap-2 py-4">
            <CardHeader className="px-4">
              <CardDescription>Due today</CardDescription>
              <CardTitle className="text-2xl tabular-nums">Rs. {data.dueToday}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 px-4">
              <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
                <dt className="text-muted-foreground">Pay to</dt>
                <dd className="font-medium">{data.upi.payeeName}</dd>
                <dt className="text-muted-foreground">UPI ID</dt>
                <dd className="font-medium break-all select-all">{data.upi.vpa}</dd>
                <dt className="text-muted-foreground">Note for the payment</dt>
                <dd className="select-all">Fees {data.studentCode}</dd>
              </dl>
              {hasDue && upiLink && (
                <Button asChild className="min-h-11 justify-self-start">
                  <a href={upiLink}>
                    <Smartphone aria-hidden="true" /> Open UPI app
                  </a>
                </Button>
              )}
              <p className="text-xs text-muted-foreground">On a computer, pay from your phone&apos;s UPI app to the UPI ID above. Check the payee name before you pay.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>I have paid</h2>
              </CardTitle>
              <CardDescription>The school checks every payment against its bank statement before issuing the receipt.</CardDescription>
            </CardHeader>
            <CardContent>{hasDue ? <ClaimForm studentId={studentId} due={data.dueToday} today={data.today} earliest={data.earliest} /> : <p className="text-sm text-muted-foreground">Nothing is due right now.</p>}</CardContent>
          </Card>
        </>
      )}
      {data.claims.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-lg font-semibold">Payments you reported</h2>
          <ul className="grid gap-2">
            {data.claims.map((c) => (
              <li key={c.id}>
                <Card className="py-3">
                  <CardContent className="flex flex-wrap items-center justify-between gap-2 px-4">
                    <span className="text-sm">
                      <span className="font-medium tabular-nums">Rs. {c.amount}</span> · {c.method === "UPI" ? "UPI" : "Bank transfer"} · ref. …{c.refEnd} · {day(c.paidOn)}
                    </span>
                    {c.receiptCancelled ? <Badge variant="destructive">Receipt cancelled</Badge> : <Badge variant={STATUS[c.status].variant}>{STATUS[c.status].label}</Badge>}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
