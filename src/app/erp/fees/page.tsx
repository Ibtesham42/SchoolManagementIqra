import { CheckCircle2, CircleOff } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { feeAccess } from "@/modules/fees/fees.policy";
import { listFeeCategories } from "@/modules/fees/setup.service";
import { getFeeNumberFormats } from "@/modules/settings/settings.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { setCategoryActiveAction } from "./actions";
import { CategoryForm, NumberFormatsForm } from "./fees-forms";
import { FeesTabs } from "./fees-tabs";

export const metadata = { title: "Fees" };

const KIND = { REGULAR: "Regular", ONE_TIME: "One-time", OTHER: "Other", TRANSPORT: "Transport (system)", LATE_FEE: "Late fee (system)", OPENING_BALANCE: "Previous dues (system)" } as const;
const APPLIES = { ALL: "every student", NEW_ADMISSION: "new admissions only", EXISTING: "existing students only" } as const;

export default async function FeesPage() {
  const ctx = await requireAuth();
  const access = feeAccess(ctx);
  if (!access.setup) return <NotPermitted />;
  const [categories, formats] = await Promise.all([listFeeCategories(ctx, { includeInactive: true }), access.manageSetup ? getFeeNumberFormats(ctx) : Promise.resolve(null)]);
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Fees" description="Fee heads are the school's own fee names (tuition, admission, lab and so on). Amounts are set per class and installment under Class fees." />
      <FeesTabs current="heads" />
      {formats && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Receipt and invoice numbers</h2>
            </CardTitle>
            <CardDescription>{formats.feeReceipt && formats.feeInvoice ? "Numbers already issued never change." : "Not set yet: invoices and receipts can't be issued until both formats are saved."}</CardDescription>
          </CardHeader>
          <CardContent>
            <NumberFormatsForm defaults={{ feeReceipt: formats.feeReceipt ?? "", feeInvoice: formats.feeInvoice ?? "" }} />
          </CardContent>
        </Card>
      )}
      {access.manageSetup && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Add a fee head</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryForm defaults={{ code: "", name: "", kind: "", appliesTo: "" }} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Fee heads</h2>
          </CardTitle>
          <CardDescription>{categories.length === 0 ? "No fee heads yet." : `${categories.length} fee head${categories.length === 1 ? "" : "s"}.`}</CardDescription>
        </CardHeader>
        {categories.length > 0 && (
          <CardContent>
            <ul className="grid gap-3">
              {categories.map((c) => (
                <li key={c.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-medium">
                      {c.name} <span className="text-xs text-muted-foreground">({c.code})</span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <Badge variant="outline">{KIND[c.kind]}</Badge>
                      {!c.isActive && <Badge variant="secondary">Inactive</Badge>}
                    </span>
                  </div>
                  <p className="text-muted-foreground">Paid by {APPLIES[c.appliesTo]}.</p>
                  {access.manageSetup && !c.system && (
                    <div className="grid gap-2">
                      <details className="rounded-lg border p-3">
                        <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Edit {c.name}</summary>
                        <div className="mt-3">
                          <CategoryForm defaults={{ id: c.id, version: c.version, code: c.code, name: c.name, kind: c.kind, appliesTo: c.appliesTo }} />
                        </div>
                      </details>
                      <ConfirmAction
                        label={c.isActive ? "Deactivate" : "Activate"}
                        icon={c.isActive ? <CircleOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                        variant={c.isActive ? "destructive" : undefined}
                        title={`${c.isActive ? "Deactivate" : "Activate"} ${c.name}?`}
                        description={c.isActive ? "It can't be added to fee structures any more. Issued invoices keep it." : "It can be added to fee structures again."}
                        confirmLabel={c.isActive ? "Deactivate" : "Activate"}
                        action={setCategoryActiveAction}
                        fields={{ id: c.id, version: String(c.version), active: c.isActive ? "false" : "true" }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
