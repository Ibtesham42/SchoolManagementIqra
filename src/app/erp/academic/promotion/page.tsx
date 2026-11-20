import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { listSessionsForSections } from "@/modules/academic/sections.service";
import { getSectionPromotion, listPromotionSections } from "@/modules/students/promotion.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { academicTabFlags } from "../tab-flags";
import { ConfirmForm, ProposeForm, type PromotionRow } from "./promotion-forms";

export const metadata = { title: "Promotion" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const LABEL = { PROMOTE: "Promote", DETAIN: "Detain", LEAVE: "Leave" } as const;
const LEAVE_LABEL: Record<string, string> = { GRADUATED: "graduated", TRANSFERRED: "transferred", WITHDRAWN: "withdrawn" };

export default async function PromotionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const flags = academicTabFlags(ctx);
  if (!flags.showPromotion) return <NotPermitted />;
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const { sessions, currentId } = await listSessionsForSections(ctx).catch(() => ({ sessions: [], currentId: null }));
  const session = sessions.find((s) => s.id === pick("session")) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];
  const sections = session ? await listPromotionSections(ctx, session.id) : [];
  const section = sections.find((s) => s.id === pick("section")) ?? sections[0];
  const data = section
    ? await getSectionPromotion(ctx, section.id, pick("target")).catch((e: unknown) => {
        if (e instanceof NotFoundError) notFound();
        throw e;
      })
    : null;

  const canPromote = data ? data.next === "one" || data.next === "choose" : false;
  const rows: PromotionRow[] =
    data?.rows.map((r) => ({
      enrollmentId: r.enrollmentId,
      rollNumber: r.rollNumber,
      studentCode: r.studentCode,
      fullName: r.fullName,
      editable: r.editable && !data.section.closed,
      decision: r.decision?.decision ?? (canPromote ? "PROMOTE" : data.next === "completes" ? "LEAVE" : "DETAIN"),
      toClassId: r.decision?.toClassId ?? "",
      leaveAs: r.decision?.leaveAs ?? (data.next === "completes" ? "GRADUATED" : ""),
      version: r.decision?.version ?? null,
      summary: r.decision
        ? `${r.decision.status === "CONFIRMED" ? "Confirmed" : "Proposed"}: ${LABEL[r.decision.decision]}${r.decision.toClassName ? ` → ${r.decision.toClassName}` : ""}${r.decision.leaveAs ? ` (${LEAVE_LABEL[r.decision.leaveAs]})` : ""}`
        : null,
    })) ?? [];
  // Classes students of this section can move to: the same class (detained) and the next class(es).
  const targetClasses = data
    ? [{ id: data.section.classId, name: `${data.section.className} (detained)` }, ...data.nextClasses].map((c) => ({
        ...c,
        sections: data.targetSections.filter((t) => t.classId === c.id).map((t) => ({ id: t.id, label: `${t.code} (${t.active}/${t.capacity})` })),
      }))
    : [];

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Promotion" description="At the end of the session the class teacher proposes promote, detain or leave for each student; the school office confirms." />
      <AcademicTabs current="promotion" {...flags} />
      {sections.length > 1 && section && (
        <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <input type="hidden" name="session" value={session?.id} />
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="pr-section">
            Section
            <select id="pr-section" name="section" defaultValue={section.id} className={FIELD}>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" className="min-h-11">
            Show
          </Button>
        </form>
      )}
      {!data ? (
        <Alert>
          <AlertDescription>{!session ? "No academic session exists yet." : "You aren't class teacher of a section in the current session."}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  {data.section.code} · {data.section.sessionName}
                </h2>
              </CardTitle>
              <CardDescription>
                {data.next === "completes"
                  ? "This is the highest class: students leave (graduated) or are detained."
                  : data.next === "none_configured"
                    ? "No active class exists at the next level yet, so students can only be detained or leave until it is created."
                    : data.nextClasses.length > 1
                      ? `Promoted students move to one of: ${data.nextClasses.map((c) => c.name).join(", ")}.`
                      : `Promoted students move to ${data.nextClasses[0]?.name}.`}{" "}
                {data.pending} proposal(s) waiting for confirmation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active students in this section.</p>
              ) : (
                <ProposeForm key={data.section.id} sectionId={data.section.id} rows={rows} nextClasses={data.nextClasses} canPromote={canPromote} />
              )}
            </CardContent>
          </Card>

          {data.access.confirm && data.pending > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Confirm promotions</h2>
                </CardTitle>
                <CardDescription>
                  {data.confirmBlocker ?? `Confirms all ${data.pending} proposal(s) of ${data.section.code}. Session ends ${formatDateOnly(new Date(`${data.section.sessionEnd}T00:00:00.000Z`))}.`}
                </CardDescription>
              </CardHeader>
              {!data.confirmBlocker && (
                <CardContent className="grid gap-3">
                  {data.targetSessions.length === 0 ? (
                    <p className="text-sm">Create the next academic session (Settings → Sessions) and its sections first.</p>
                  ) : (
                    <>
                      {data.targetSessions.length > 1 && (
                        <form method="get" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                          <input type="hidden" name="session" value={session?.id} />
                          <input type="hidden" name="section" value={data.section.id} />
                          <label className="grid gap-1.5 text-sm font-medium" htmlFor="pr-target">
                            Next session
                            <select id="pr-target" name="target" defaultValue={data.targetSession?.id} className={FIELD}>
                              {data.targetSessions.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <Button type="submit" variant="outline" className="min-h-11">
                            Show sections
                          </Button>
                        </form>
                      )}
                      <p className="text-sm text-muted-foreground">Into {data.targetSession?.name}. Only classes that students actually move to need a section.</p>
                      <ConfirmForm key={data.targetSession?.id} sectionId={data.section.id} targetSessionId={data.targetSession!.id} classes={targetClasses} />
                    </>
                  )}
                </CardContent>
              )}
            </Card>
          )}
          {!hasPermission(ctx, "student.promote") && data.pending > 0 && <p className="text-sm text-muted-foreground">The school office confirms the proposals after the session ends.</p>}
        </>
      )}
    </div>
  );
}
