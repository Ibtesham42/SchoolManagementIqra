import { requireAuth } from "@/lib/auth/context";
import { holdsAll } from "@/modules/fees/fees.policy";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { CollectionSearch } from "../collect-forms";
import { FeesTabs } from "../fees-tabs";

export const metadata = { title: "Collect fees" };

export default async function CollectPage() {
  const ctx = await requireAuth();
  if (!holdsAll(ctx, "fee.collect")) return <NotPermitted />;
  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <PageHeader title="Fees" description="Collect a payment at the counter and give a receipt." />
      <FeesTabs current="collect" />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Find the student</h2>
          </CardTitle>
          <CardDescription>Students from every session, so previous dues can be collected too.</CardDescription>
        </CardHeader>
        <CardContent>
          <CollectionSearch />
        </CardContent>
      </Card>
    </div>
  );
}
