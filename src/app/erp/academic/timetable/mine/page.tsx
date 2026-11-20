import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { listSessionsForSections } from "@/modules/academic/sections.service";
import { getMyTimetable, WEEKDAYS } from "@/modules/academic/timetable.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../../academic-tabs";
import { academicTabFlags } from "../../tab-flags";

export const metadata = { title: "My timetable" };

export default async function MyTimetablePage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "timetable.read") || !hasPermission(ctx, "academic.read")) return <NotPermitted />;
  const academicScope = scopeFor(ctx, "academic.read");
  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === currentId) ?? sessions[0];
  const header = (
    <>
      <PageHeader title="My timetable" description={session ? `Your lessons in ${session.name}.` : "Your lessons."} />
      <AcademicTabs current="my-timetable" {...academicTabFlags(ctx)} />
    </>
  );
  if (!session) {
    return (
      <div className="mx-auto grid max-w-4xl gap-4">
        {header}
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      </div>
    );
  }
  const mine = await getMyTimetable(ctx, session.id);
  if (!mine.linked) {
    return (
      <div className="mx-auto grid max-w-4xl gap-4">
        {header}
        <p className="rounded-lg border p-4 text-sm">Your login isn&apos;t linked to your staff record yet, so there is no timetable to show. Ask a Super Admin to link it.</p>
      </div>
    );
  }
  const byPeriod = new Map(mine.slots.map((s) => [s.periodId, s]));
  const days = [...new Set(mine.periods.map((p) => p.dayOfWeek))].sort();
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      {header}
      <p className="text-sm text-muted-foreground">{mine.slots.length} lesson{mine.slots.length === 1 ? "" : "s"} a week.</p>
      {days.map((d) => {
        const periods = mine.periods.filter((p) => p.dayOfWeek === d);
        const lessons = periods.filter((p) => byPeriod.has(p.id)).length;
        return (
          <Card key={d}>
            <CardHeader>
              <CardTitle>
                <h2>{WEEKDAYS[d]}</h2>
              </CardTitle>
              <CardDescription>{lessons === 0 ? "No lessons." : `${lessons} lesson${lessons === 1 ? "" : "s"}`}</CardDescription>
            </CardHeader>
            {lessons > 0 && (
              <CardContent>
                <ol className="grid gap-2">
                  {periods.map((p) => {
                    const s = byPeriod.get(p.id);
                    return (
                      <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-3 text-sm">
                        <span className="text-muted-foreground">
                          P{p.number} · {p.startTime}–{p.endTime}
                        </span>
                        {s ? (
                          <span className="font-medium">
                            {s.classSubject.subject.name} · {s.section.code}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{p.kind === "BREAK" ? "Break" : "Free"}</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
