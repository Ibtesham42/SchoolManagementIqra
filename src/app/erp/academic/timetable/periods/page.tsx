import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { isSessionWritable } from "@/modules/academic/academic.rules";
import { listSessionsForSections } from "@/modules/academic/sections.service";
import { getPeriodPlan } from "@/modules/academic/timetable.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../../academic-tabs";
import { CopyDayForm, DayPlanForm } from "../timetable-forms";
import { TimetableNav } from "../timetable-nav";

export const metadata = { title: "Periods" };

const STATUS_LABEL = { PLANNED: "Planned", ACTIVE: "Active", CLOSED: "Closed" } as const;
const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

export default async function PeriodsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "timetable.read") || scopeFor(ctx, "timetable.read") !== "ALL" || !hasPermission(ctx, "academic.read") || scopeFor(ctx, "academic.read") !== "ALL") {
    return <NotPermitted />;
  }
  const canManage = hasPermission(ctx, "timetable.manage");
  const linked = typeof ctx.employeeId === "string" && ctx.employeeId !== "";
  const sp = await searchParams;
  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === (typeof sp.session === "string" ? sp.session : "")) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];

  const header = (
    <>
      <PageHeader title="Periods (bell schedule)" description="The school day for each weekday of an academic session: lesson periods and breaks, with times. Leave a day empty for a weekly off." />
      <AcademicTabs current="timetable" showClasses showSubjects showTimetable showMine={linked} />
      <TimetableNav current="periods" showPeriods />
    </>
  );
  if (!session) {
    return (
      <div className="mx-auto grid max-w-5xl gap-4">
        {header}
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      </div>
    );
  }
  const plan = await getPeriodPlan(ctx, session.id);
  const writable = canManage && isSessionWritable(session.status);

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      {header}
      <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium sm:w-72" htmlFor="pp-session">
          Academic session
          <select id="pp-session" name="session" defaultValue={session.id} className={FIELD}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({STATUS_LABEL[s.status]})
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Show
        </Button>
      </form>
      {session.status === "CLOSED" && <p className="rounded-lg border p-3 text-sm">{session.name} is closed: its periods are read-only.</p>}
      {plan.days.map((d) => (
        <Card key={d.dayOfWeek}>
          <CardHeader>
            <CardTitle>
              <h2>{d.name}</h2>
            </CardTitle>
            <CardDescription>
              {d.periods.length === 0 ? "No periods." : `${d.periods.length} period${d.periods.length === 1 ? "" : "s"} · ${d.periods[0].startTime}–${d.periods.at(-1)!.endTime}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <details className="rounded-lg border p-3" open={d.dayOfWeek === 1 && d.periods.length === 0 && writable}>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">{writable ? `Edit ${d.name}` : `Show ${d.name}`}</summary>
              <div className="mt-3">
                <DayPlanForm academicSessionId={session.id} dayOfWeek={d.dayOfWeek} fingerprint={d.fingerprint} periods={d.periods} disabled={!writable} />
              </div>
            </details>
          </CardContent>
        </Card>
      ))}
      {writable && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Copy a day</h2>
            </CardTitle>
            <CardDescription>Set up one day, then copy it to the others.</CardDescription>
          </CardHeader>
          <CardContent>
            <CopyDayForm academicSessionId={session.id} days={plan.days.map((d) => ({ value: d.dayOfWeek, label: d.name, fingerprint: d.fingerprint }))} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
