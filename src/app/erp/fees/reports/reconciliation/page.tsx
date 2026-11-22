import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { canReadFeeReports } from "@/modules/fees/fees.policy";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { FeesTabs } from "../../fees-tabs";
import { ReconciliationRunner } from "../../reconciliation-form";

export const metadata = { title: "Fee reconciliation" };

export default async function ReconciliationPage() {
  const ctx = await requireAuth();
  if (!canReadFeeReports(ctx)) return <NotPermitted />;
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title="Fees" description="Check that receipts, invoices and their numbers all add up." />
      <FeesTabs current="reports" />
      <p className="text-sm">
        <Link href="/erp/fees/reports" className="underline">
          Back to reports
        </Link>
      </p>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Reconciliation</h2>
          </CardTitle>
          <CardDescription>
            Seven checks over every receipt and invoice. Problems list receipt or invoice numbers only. Run it before closing a term or a financial year.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReconciliationRunner />
        </CardContent>
      </Card>
    </div>
  );
}
