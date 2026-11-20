import { Ban, Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly } from "@/lib/format";
import { feeAccess } from "@/modules/fees/fees.policy";
import { feeSetupOptions, getLateFeeRule, listFeeInstallments } from "@/modules/fees/setup.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { clearLateFeeRuleAction, deleteInstallmentAction } from "../actions";
import { InstallmentForm, LateFeeForm } from "../fees-forms";
import { FeesTabs, pickSession, SessionPicker } from "../fees-tabs";

export const metadata = { title: "Installments and late fee" };

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const RULE = { FLAT: "a fixed amount of ₹", PER_DAY: "₹", PERCENT: "" } as const;

export default async function SchedulePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const access = feeAccess(ctx);
  if (!access.setup) return <NotPermitted />;
  const { sessions } = await feeSetupOptions(ctx);
  const session = pickSession(sessions, (await searchParams).session);
  const [installments, rule] = session ? await Promise.all([listFeeInstallments(ctx, session.id), getLateFeeRule(ctx, session.id)]) : [[], null];
  const writable = access.manageSetup && session !== undefined && session.status !== "CLOSED";
  const ruleText = rule
    ? `${rule.calc === "PERCENT" ? `${Number(rule.value)} % of what is unpaid` : `${RULE[rule.calc]}${rule.value}${rule.calc === "PER_DAY" ? " for each day late" : ""}`}, starting ${rule.graceDays} day${rule.graceDays === 1 ? "" : "s"} after the due date${rule.cap ? `, at most ₹${rule.cap}` : ""}.`
    : "No late fee.";
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Fees" description="The school's installments for a session (monthly, quarterly or terms) and its late-fee rule." />
      <FeesTabs current="schedule" session={session?.id} />
      <SessionPicker sessions={sessions} current={session?.id ?? ""} action="/erp/fees/schedule" />
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
                  <h2>Add an installment to {session.name}</h2>
                </CardTitle>
                <CardDescription>
                  Due dates must be inside the session ({formatDateOnly(day(session.startDate))} to {formatDateOnly(day(session.endDate))}).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <InstallmentForm key={session.id} sessionId={session.id} defaults={{ name: "", dueOn: "", sortOrder: installments.length }} min={session.startDate} max={session.endDate} />
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  {session.name}: installments ({installments.length})
                </h2>
              </CardTitle>
              <CardDescription>Issued invoices keep their own due date, so changing an installment later never moves them.</CardDescription>
            </CardHeader>
            <CardContent>
              {installments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No installments yet.</p>
              ) : (
                <ul className="grid gap-3">
                  {installments.map((i) => (
                    <li key={i.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">{i.name}</span>
                        <span className="text-muted-foreground">Due {formatDateOnly(day(i.dueOn))}</span>
                      </div>
                      {writable && (
                        <div className="flex flex-wrap items-start gap-2">
                          <details className="grow rounded-lg border p-3">
                            <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Edit {i.name}</summary>
                            <div className="mt-3">
                              <InstallmentForm defaults={{ id: i.id, version: i.version, name: i.name, dueOn: i.dueOn, sortOrder: i.sortOrder }} min={session.startDate} max={session.endDate} />
                            </div>
                          </details>
                          {!i.used && (
                            <ConfirmAction label="Delete" variant="destructive" icon={<Trash2 aria-hidden="true" />} title={`Delete ${i.name}?`} description="Nothing uses it yet, so it is removed completely." confirmLabel="Delete" action={deleteInstallmentAction} fields={{ id: i.id, version: String(i.version) }} />
                          )}
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
                <h2>Late fee for {session.name}</h2>
              </CardTitle>
              <CardDescription>{ruleText} It is worked out on the day a payment is collected.</CardDescription>
            </CardHeader>
            {writable && (
              <CardContent className="grid gap-3">
                <LateFeeForm key={session.id} sessionId={session.id} defaults={{ graceDays: rule?.graceDays ?? 0, calc: rule?.calc ?? "FLAT", value: rule?.value ?? "", cap: rule?.cap ?? "" }} />
                {rule && (
                  <ConfirmAction label="Turn off the late fee" variant="destructive" icon={<Ban aria-hidden="true" />} title="Turn off the late fee?" description="No late fee is added to payments collected from now on." confirmLabel="Turn off" action={clearLateFeeRuleAction} fields={{ academicSessionId: session.id }} />
                )}
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
