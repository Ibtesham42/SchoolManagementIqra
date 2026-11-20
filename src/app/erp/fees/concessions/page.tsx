import { Ban, CheckCircle2, CircleOff, XCircle } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateTime } from "@/lib/format";
import { formatIndianMoney } from "@/lib/money";
import { listConcessions, listStudentConcessions, searchStudentsForFees } from "@/modules/fees/concessions.service";
import { feeAccess } from "@/modules/fees/fees.policy";
import { feeSetupOptions, listFeeCategories } from "@/modules/fees/setup.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { decideConcessionAction, revokeConcessionAction, setConcessionActiveAction } from "../actions";
import { ConcessionForm, ProposeForm } from "../concession-forms";
import { FeesTabs, pickSession, SessionPicker } from "../fees-tabs";
import { StudentSearch } from "../student-search";

export const metadata = { title: "Concessions" };

const STATUS = { PROPOSED: "Waiting for approval", APPROVED: "Approved", REJECTED: "Rejected", REVOKED: "Revoked" } as const;
const valueText = (calc: string, value: string) => (calc === "PERCENT" ? `${Number(value)} %` : `₹${formatIndianMoney(value)} per installment`);

export default async function ConcessionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const access = feeAccess(ctx);
  if (!access.concessions || !access.setup) return <NotPermitted />;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const { sessions } = await feeSetupOptions(ctx);
  const session = pickSession(sessions, sp.session);
  const [templates, register, heads, found, tz] = await Promise.all([
    listConcessions(ctx, { includeInactive: true }),
    session ? listStudentConcessions(ctx, session.id) : Promise.resolve([]),
    access.proposeConcessions ? listFeeCategories(ctx) : Promise.resolve([]),
    session && access.proposeConcessions && q.length >= 2 ? searchStudentsForFees(ctx, session.id, q) : Promise.resolve([]),
    getSchoolTimezone(),
  ]);
  const schoolHeads = heads.filter((h) => !h.system).map((h) => ({ id: h.id, name: h.name }));
  const activeTemplates = templates.filter((t) => t.isActive).map((t) => ({ id: t.id, label: `${t.name} (${valueText(t.calc, t.value)})` }));
  const writable = session !== undefined && session.status !== "CLOSED";
  const pending = register.filter((r) => r.status === "PROPOSED");
  const decided = register.filter((r) => r.status !== "PROPOSED");
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Fees" description="Concessions and scholarships: the accountant proposes one for a student and someone else with approval rights approves it. Approved concessions apply to invoices issued afterwards." />
      <FeesTabs current="concessions" session={session?.id} />
      <SessionPicker sessions={sessions} current={session?.id ?? ""} action="/erp/fees/concessions" />
      {!session ? (
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      ) : (
        <>
          {pending.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Waiting for approval ({pending.length})</h2>
                </CardTitle>
                <CardDescription>The session effect is worked out from the class&apos;s active fees.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-3">
                  {pending.map((r) => (
                    <li key={r.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {r.fullName} <span className="text-muted-foreground">({r.studentCode}, {r.sectionCode})</span>
                        </span>
                        <Badge variant="secondary">{STATUS[r.status]}</Badge>
                      </div>
                      <p>
                        {r.concessionName}: {valueText(r.calc, r.value)}
                        {r.effect && (
                          <span className="text-muted-foreground">
                            {" "}
                            · about ₹{formatIndianMoney(r.effect.sessionTotal)} for the session over {r.effect.installments} installment{r.effect.installments === 1 ? "" : "s"}
                          </span>
                        )}
                      </p>
                      {r.reason && <p className="text-muted-foreground">Reason: {r.reason}</p>}
                      <p className="text-xs text-muted-foreground">
                        Proposed by {r.proposedBy ?? "a removed user"} on {formatDateTime(r.proposedAt, tz)}
                      </p>
                      {access.approveConcessions && writable && !r.ownProposal && (
                        <div className="flex flex-wrap gap-2">
                          <ConfirmAction label="Approve" icon={<CheckCircle2 aria-hidden="true" />} title={`Approve ${r.concessionName} for ${r.fullName}?`} description="It applies to invoices issued from now on." confirmLabel="Approve" action={decideConcessionAction} fields={{ id: r.id, version: String(r.version), decision: "APPROVE" }} />
                          <ConfirmAction label="Reject" variant="destructive" icon={<XCircle aria-hidden="true" />} title={`Reject ${r.concessionName} for ${r.fullName}?`} description="It can be proposed again later." confirmLabel="Reject" action={decideConcessionAction} fields={{ id: r.id, version: String(r.version), decision: "REJECT" }} />
                        </div>
                      )}
                      {r.ownProposal && <p className="text-xs text-muted-foreground">You proposed this, so someone else must decide it.</p>}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {access.proposeConcessions && writable && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Propose a concession</h2>
                </CardTitle>
                <CardDescription>{activeTemplates.length === 0 ? "Add a concession below first." : `Students enrolled in ${session.name}.`}</CardDescription>
              </CardHeader>
              {activeTemplates.length > 0 && (
                <CardContent className="grid gap-3">
                  <StudentSearch action="/erp/fees/concessions" session={session.id} q={q} />
                  {q.length >= 2 && found.length === 0 && <p className="text-sm text-muted-foreground">No student found.</p>}
                  <ul className="grid gap-3">
                    {found.map((s) => (
                      <li key={s.studentId} className="grid gap-2 rounded-lg border p-3 text-sm">
                        <span className="font-medium">
                          {s.fullName} <span className="text-muted-foreground">({s.studentCode}, {s.className} {s.sectionCode})</span>
                        </span>
                        <details className="rounded-lg border p-3">
                          <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Propose for {s.fullName}</summary>
                          <div className="mt-3">
                            <ProposeForm studentId={s.studentId} sessionId={session.id} concessions={activeTemplates} />
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
                  {session.name}: concession register ({decided.length})
                </h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {decided.length === 0 ? (
                <p className="text-sm text-muted-foreground">No decided concessions yet.</p>
              ) : (
                <ul className="grid gap-2">
                  {decided.map((r) => (
                    <li key={r.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {r.fullName} <span className="text-muted-foreground">({r.studentCode})</span>
                        </span>
                        <Badge variant={r.status === "APPROVED" ? "default" : "secondary"}>{STATUS[r.status]}</Badge>
                      </div>
                      <p>
                        {r.concessionName}: {valueText(r.calc, r.value)}
                        {r.effect && r.status === "APPROVED" && <span className="text-muted-foreground"> · about ₹{formatIndianMoney(r.effect.sessionTotal)} for the session</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Proposed by {r.proposedBy ?? "a removed user"}
                        {r.decidedBy ? ` · decided by ${r.decidedBy}` : ""}
                        {r.decidedAt ? ` on ${formatDateTime(r.decidedAt, tz)}` : ""}
                      </p>
                      {r.status === "APPROVED" && access.approveConcessions && writable && (
                        <div>
                          <ConfirmAction label="Revoke" variant="destructive" icon={<Ban aria-hidden="true" />} title={`Revoke ${r.concessionName} for ${r.fullName}?`} description="Invoices issued from now on won't include it. Issued invoices keep it." confirmLabel="Revoke" action={revokeConcessionAction} fields={{ id: r.id, version: String(r.version) }} />
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

      {access.proposeConcessions && schoolHeads.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Add a concession</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ConcessionForm heads={schoolHeads} defaults={{ code: "", name: "", kind: "", calc: "", value: "", categoryIds: [] }} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Concessions ({templates.length})</h2>
          </CardTitle>
        </CardHeader>
        {templates.length > 0 && (
          <CardContent>
            <ul className="grid gap-3">
              {templates.map((t) => (
                <li key={t.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {t.name} <span className="text-xs text-muted-foreground">({t.code})</span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <Badge variant="outline">{valueText(t.calc, t.value)}</Badge>
                      {!t.isActive && <Badge variant="secondary">Inactive</Badge>}
                    </span>
                  </div>
                  <p className="text-muted-foreground">On {t.categoryNames.join(", ")}</p>
                  {access.proposeConcessions && (
                    <div className="grid gap-2">
                      {schoolHeads.length > 0 && (
                        <details className="rounded-lg border p-3">
                          <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Edit {t.name}</summary>
                          <div className="mt-3">
                            <ConcessionForm heads={schoolHeads} defaults={{ id: t.id, version: t.version, code: t.code, name: t.name, kind: t.kind, calc: t.calc, value: t.value, categoryIds: t.categoryIds, locked: t.inUse }} />
                          </div>
                        </details>
                      )}
                      <ConfirmAction
                        label={t.isActive ? "Deactivate" : "Activate"}
                        icon={t.isActive ? <CircleOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                        variant={t.isActive ? "destructive" : undefined}
                        title={`${t.isActive ? "Deactivate" : "Activate"} ${t.name}?`}
                        description={t.isActive ? "It can't be proposed any more. Approved concessions stay." : "It can be proposed again."}
                        confirmLabel={t.isActive ? "Deactivate" : "Activate"}
                        action={setConcessionActiveAction}
                        fields={{ id: t.id, version: String(t.version), active: t.isActive ? "false" : "true" }}
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
