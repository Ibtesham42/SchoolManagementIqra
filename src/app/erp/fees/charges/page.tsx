import { Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatIndianMoney } from "@/lib/money";
import { listCharges, searchStudentsForFees } from "@/modules/fees/concessions.service";
import { feeAccess } from "@/modules/fees/fees.policy";
import { feeSetupOptions, listFeeCategories, listFeeInstallments } from "@/modules/fees/setup.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { removeChargeAction } from "../actions";
import { ChargeForm } from "../concession-forms";
import { FeesTabs, pickSession, SessionPicker } from "../fees-tabs";
import { StudentSearch } from "../student-search";

export const metadata = { title: "Extra charges" };

export default async function ChargesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const access = feeAccess(ctx);
  if (!access.setup) return <NotPermitted />;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const { sessions } = await feeSetupOptions(ctx);
  const session = pickSession(sessions, sp.session);
  const [charges, heads, installments, found] = session
    ? await Promise.all([
        listCharges(ctx, session.id),
        listFeeCategories(ctx),
        listFeeInstallments(ctx, session.id),
        access.manageSetup && q.length >= 2 ? searchStudentsForFees(ctx, session.id, q) : Promise.resolve([]),
      ])
    : [[], [], [], []];
  const schoolHeads = heads.filter((h) => !h.system).map((h) => ({ id: h.id, name: h.name }));
  const insts = installments.map((i) => ({ id: i.id, name: i.name }));
  const writable = access.manageSetup && session !== undefined && session.status !== "CLOSED";
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Fees" description="Extra charges for one student on one installment (hostel, an activity, a bounced-cheque charge). They are added to that installment's invoice." />
      <FeesTabs current="charges" session={session?.id} />
      <SessionPicker sessions={sessions} current={session?.id ?? ""} action="/erp/fees/charges" />
      {!session ? (
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      ) : (
        <>
          {writable && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Add a charge</h2>
                </CardTitle>
                <CardDescription>{schoolHeads.length === 0 || insts.length === 0 ? "Add fee heads and this session's installments first." : `Students enrolled in ${session.name}.`}</CardDescription>
              </CardHeader>
              {schoolHeads.length > 0 && insts.length > 0 && (
                <CardContent className="grid gap-3">
                  <StudentSearch action="/erp/fees/charges" session={session.id} q={q} />
                  {q.length >= 2 && found.length === 0 && <p className="text-sm text-muted-foreground">No student found.</p>}
                  <ul className="grid gap-3">
                    {found.map((s) => (
                      <li key={s.studentId} className="grid gap-2 rounded-lg border p-3 text-sm">
                        <span className="font-medium">
                          {s.fullName} <span className="text-muted-foreground">({s.studentCode}, {s.className} {s.sectionCode})</span>
                        </span>
                        <details className="rounded-lg border p-3">
                          <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Add a charge for {s.fullName}</summary>
                          <div className="mt-3">
                            <ChargeForm studentId={s.studentId} sessionId={session.id} heads={schoolHeads} installments={insts} />
                          </div>
                        </details>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              )}
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  {session.name}: extra charges ({charges.length})
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {charges.length === 0 ? (
                <p className="text-sm text-muted-foreground">No extra charges.</p>
              ) : (
                <ul className="grid gap-2">
                  {charges.map((c) => (
                    <li key={c.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {c.fullName} <span className="text-muted-foreground">({c.studentCode}, {c.sectionCode})</span>
                        </span>
                        <span className="tabular-nums">₹{formatIndianMoney(c.amount)}</span>
                      </div>
                      <p>
                        {c.categoryName} · {c.installmentName} · {c.note}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        {c.invoiced && <Badge variant="outline">On an invoice</Badge>}
                        {c.source === "TRANSPORT" && <Badge variant="outline">Transport</Badge>}
                        {writable && !c.invoiced && c.source === "MANUAL" && (
                          <ConfirmAction label="Remove" variant="destructive" icon={<Trash2 aria-hidden="true" />} title="Remove this charge?" description="It won't be added to the invoice." confirmLabel="Remove" action={removeChargeAction} fields={{ id: c.id, version: String(c.version) }} />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
