import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { isSessionWritable } from "@/modules/academic/academic.rules";
import { listSections, listSessionsForSections } from "@/modules/academic/sections.service";
import { getSectionTimetable, WEEKDAYS } from "@/modules/academic/timetable.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { SlotForm } from "./timetable-forms";
import { DAY_SHORT, TimetableNav } from "./timetable-nav";

export const metadata = { title: "Timetable" };

const STATUS_LABEL = { PLANNED: "Planned", ACTIVE: "Active", CLOSED: "Closed" } as const;
const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

export default async function TimetablePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const academicScope = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  if (!hasPermission(ctx, "timetable.read") || scopeFor(ctx, "timetable.read") !== "ALL" || (academicScope !== "ALL" && academicScope !== "ASSIGNED")) {
    return <NotPermitted />;
  }
  const canManage = hasPermission(ctx, "timetable.manage");
  const linked = typeof ctx.employeeId === "string" && ctx.employeeId !== "";
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === pick("session")) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];
  // Scoped list: class teachers (ASSIGNED) see their own section(s); school-wide readers see all.
  const sections = session ? await listSections(ctx, { academicSessionId: session.id }) : [];
  const section = sections.find((s) => s.id === pick("section")) ?? sections[0];

  const header = (
    <>
      <PageHeader title="Timetable" description="Each section's week, period by period. The teacher of a lesson is the subject's allocated teacher in that section." />
      <AcademicTabs current="timetable" showClasses={academicScope === "ALL"} showSubjects={academicScope === "ALL"} showTimetable showMine={linked} />
      <TimetableNav current="section" showPeriods={canManage || academicScope === "ALL"} />
    </>
  );
  if (!session || !section) {
    return (
      <div className="mx-auto grid max-w-5xl gap-4">
        {header}
        <Alert>
          <AlertDescription>{!session ? "No academic session exists yet." : "No section to show."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const data = await getSectionTimetable(ctx, section.id);
  const writable = canManage && isSessionWritable(session.status);
  const daysWithPeriods = [...new Set(data.periods.map((p) => p.dayOfWeek))].sort();
  const requestedDay = Number(pick("day"));
  const day = daysWithPeriods.includes(requestedDay) ? requestedDay : (daysWithPeriods[0] ?? 1);
  const dayPeriods = data.periods.filter((p) => p.dayOfWeek === day);
  const slotByPeriod = new Map(data.slots.map((s) => [s.periodId, s]));
  const subjectById = new Map(data.subjects.map((s) => [s.id, s]));
  const subjectOptions = data.subjects.map((s) => ({ value: s.id, label: `${s.name}${s.teacher ? ` · ${s.teacher}` : " · no teacher"}` }));
  const qs = (d: number) => new URLSearchParams({ session: session.id, section: section.id, day: String(d) }).toString();
  const maxPeriods = Math.max(0, ...data.periods.map((p) => p.number));

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      {header}
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="tt-session">
          Academic session
          <select id="tt-session" name="session" defaultValue={session.id} className={FIELD}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({STATUS_LABEL[s.status]})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="tt-section">
          Section
          <select id="tt-section" name="section" defaultValue={section.id} className={FIELD}>
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

      {data.periods.length === 0 ? (
        <Alert>
          <AlertDescription>No periods are set for {session.name} yet. Set the bell schedule under &ldquo;Periods&rdquo; first.</AlertDescription>
        </Alert>
      ) : (
        <>
          <nav aria-label="Day" className="flex flex-wrap gap-2">
            {daysWithPeriods.map((d) => (
              <Link
                key={d}
                href={`/erp/academic/timetable?${qs(d)}`}
                aria-current={d === day ? "page" : undefined}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-3 text-sm aria-[current=page]:border-primary aria-[current=page]:font-medium"
              >
                {DAY_SHORT[d]}
              </Link>
            ))}
          </nav>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  {data.section.code} · {WEEKDAYS[day]}
                </h2>
              </CardTitle>
              <CardDescription>{writable ? "Choose the subject of each lesson period and save it." : `${session.name}${session.status === "CLOSED" ? " (closed — read-only)" : ""}`}</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-2">
                {dayPeriods.map((p) => {
                  const slot = slotByPeriod.get(p.id);
                  const subj = slot ? subjectById.get(slot.classSubjectId) : undefined;
                  const label = `P${p.number} · ${p.startTime}–${p.endTime}${p.label ? ` · ${p.label}` : ""}`;
                  return (
                    <li key={p.id} className="rounded-lg border p-3 text-sm">
                      {p.kind === "BREAK" ? (
                        <p className="text-muted-foreground">{label} · Break</p>
                      ) : writable ? (
                        <SlotForm sectionId={data.section.id} periodId={p.id} version={slot?.version ?? null} current={slot?.classSubjectId ?? null} subjects={subjectOptions} label={label} />
                      ) : (
                        <p>
                          <span className="text-muted-foreground">{label}</span>
                          <br />
                          <span className="font-medium">{subj ? subj.name : "Free"}</span>
                          {slot?.employee ? ` · ${slot.employee.fullName}` : ""}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
          <Card className="hidden md:block">
            <CardHeader>
              <CardTitle>
                <h2>Week</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-xs">
                <caption className="sr-only">Week timetable of {data.section.code}</caption>
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="py-2 pr-2 font-medium">Day</th>
                    {Array.from({ length: maxPeriods }, (_, i) => (
                      <th key={i} scope="col" className="px-2 py-2 font-medium">
                        P{i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {daysWithPeriods.map((d) => (
                    <tr key={d} className="border-b last:border-0">
                      <th scope="row" className="py-2 pr-2 text-left font-medium">{DAY_SHORT[d]}</th>
                      {Array.from({ length: maxPeriods }, (_, i) => {
                        const p = data.periods.find((x) => x.dayOfWeek === d && x.number === i + 1);
                        const slot = p ? slotByPeriod.get(p.id) : undefined;
                        return (
                          <td key={i} className="px-2 py-2 align-top">
                            {!p ? "" : p.kind === "BREAK" ? <span className="text-muted-foreground">Break</span> : slot ? (subjectById.get(slot.classSubjectId)?.code ?? "?") : <span className="text-muted-foreground">–</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
