import { CheckCircle2, CircleOff } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatIndianMoney } from "@/lib/money";
import { feeAccess } from "@/modules/fees/fees.policy";
import { feeSetupOptions, listFeeCategories, listFeeInstallments, listFeeStructures } from "@/modules/fees/setup.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { setStructureActiveAction } from "../actions";
import { CopyStructureForm, StructureForm } from "../fees-forms";
import { FeesTabs, pickSession, SessionPicker } from "../fees-tabs";

export const metadata = { title: "Class fees" };

export default async function StructuresPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const access = feeAccess(ctx);
  if (!access.setup) return <NotPermitted />;
  const { sessions, classes } = await feeSetupOptions(ctx);
  const session = pickSession(sessions, (await searchParams).session);
  const [structures, installments, categories] = session
    ? await Promise.all([listFeeStructures(ctx, session.id), listFeeInstallments(ctx, session.id), listFeeCategories(ctx)])
    : [[], [], []];
  const heads = categories.filter((c) => !c.system).map((c) => ({ id: c.id, name: c.name }));
  const insts = installments.map((i) => ({ id: i.id, name: i.name }));
  const headName = new Map(categories.map((c) => [c.id, c.name]));
  const instName = new Map(installments.map((i) => [i.id, i.name]));
  const writable = access.manageSetup && session !== undefined && session.status !== "CLOSED";
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Fees" description="What each class pays per installment. One structure is active per class; invoices are made from the active one." />
      <FeesTabs current="structures" session={session?.id} />
      <SessionPicker sessions={sessions} current={session?.id ?? ""} action="/erp/fees/structures" />
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
                  <h2>Add class fees for {session.name}</h2>
                </CardTitle>
                <CardDescription>{heads.length === 0 || insts.length === 0 ? "Add fee heads and this session's installments first." : "Only active fee heads and this session's installments are offered."}</CardDescription>
              </CardHeader>
              {heads.length > 0 && insts.length > 0 && (
                <CardContent>
                  <StructureForm key={session.id} sessionId={session.id} classes={classes} categories={heads} installments={insts} defaults={{ name: "", items: [] }} />
                </CardContent>
              )}
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  {session.name}: class fees ({structures.length})
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {structures.length === 0 ? (
                <p className="text-sm text-muted-foreground">No class fees yet.</p>
              ) : (
                <ul className="grid gap-3">
                  {structures.map((s) => (
                    <li key={s.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="font-medium">
                          {s.className}: {s.name}
                        </span>
                        <span className="flex flex-wrap gap-1">
                          <Badge variant="outline" className="tabular-nums">
                            ₹{formatIndianMoney(s.total)} for the session
                          </Badge>
                          {s.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                          {s.frozen && <Badge variant="outline">Invoiced</Badge>}
                        </span>
                      </div>
                      <ul className="grid gap-1">
                        {s.items.map((it) => (
                          <li key={`${it.categoryId}-${it.installmentId}`} className="flex flex-wrap justify-between gap-2">
                            <span>
                              {headName.get(it.categoryId) ?? "Fee head"} <span className="text-muted-foreground">· {instName.get(it.installmentId) ?? "Installment"}</span>
                            </span>
                            <span className="tabular-nums">₹{formatIndianMoney(it.amount)}</span>
                          </li>
                        ))}
                      </ul>
                      {writable && (
                        <div className="grid gap-2">
                          {s.frozen && <p className="text-xs text-muted-foreground">Invoices were issued with this structure, so its amounts are fixed. Copy it, change the copy and make the copy active for future invoices.</p>}
                          <details className="rounded-lg border p-3">
                            <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Copy</summary>
                            <div className="mt-3">
                              <CopyStructureForm id={s.id} name={s.name} />
                            </div>
                          </details>
                          {!s.frozen && (
                            <details className="rounded-lg border p-3">
                              <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Edit</summary>
                              <div className="mt-3">
                                <StructureForm categories={heads} installments={insts} defaults={{ id: s.id, version: s.version, name: s.name, items: s.items }} />
                              </div>
                            </details>
                          )}
                          <ConfirmAction
                            label={s.isActive ? "Deactivate" : "Make active"}
                            icon={s.isActive ? <CircleOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                            variant={s.isActive ? "destructive" : undefined}
                            title={s.isActive ? `Deactivate ${s.name}?` : `Make ${s.name} the active fees for ${s.className}?`}
                            description={s.isActive ? "No invoices can be made for this class until another structure is active." : "Future invoices for this class use it. Issued invoices don't change."}
                            confirmLabel={s.isActive ? "Deactivate" : "Make active"}
                            action={setStructureActiveAction}
                            fields={{ id: s.id, version: String(s.version), active: s.isActive ? "false" : "true" }}
                          />
                        </div>
                      )}
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
