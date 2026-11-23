import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePortal } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { weekdayOf } from "@/lib/month";
import { cn } from "@/lib/utils";
import { getPortalAttendanceMonth, type PortalAttendanceDay } from "@/modules/students/student-attendance.portal";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Attendance" };

const MARK: Record<string, { short: string; label: string; cls: string }> = {
  PRESENT: { short: "P", label: "Present", cls: "bg-emerald-100 text-emerald-900" },
  LATE: { short: "L", label: "Late", cls: "bg-amber-100 text-amber-900" },
  HALF_DAY: { short: "H", label: "Half day", cls: "bg-amber-100 text-amber-900" },
  ABSENT: { short: "A", label: "Absent", cls: "bg-red-100 text-red-900" },
  EXCUSED: { short: "E", label: "Excused", cls: "bg-sky-100 text-sky-900" },
};
const WEEK = [["Mon", "Monday"], ["Tue", "Tuesday"], ["Wed", "Wednesday"], ["Thu", "Thursday"], ["Fri", "Friday"], ["Sat", "Saturday"], ["Sun", "Sunday"]] as const;
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

function dayText(d: PortalAttendanceDay): { short: string; label: string; cls: string } {
  if (d.kind === "school" && d.status) return MARK[d.status];
  if (d.kind === "school") return { short: "–", label: "Not marked", cls: "" };
  if (d.kind === "holiday") return { short: "Hol", label: d.holiday ? `Holiday: ${d.holiday}` : "Holiday", cls: "bg-muted text-muted-foreground" };
  if (d.kind === "weekly_off") return { short: "Off", label: "Weekly off", cls: "bg-muted text-muted-foreground" };
  return { short: "", label: d.kind === "future" ? "Upcoming" : "Not enrolled", cls: "text-muted-foreground" };
}

/** Phase 6B-M1 (P10) — a child's attendance: month calendar, month and session percentages. */
export default async function PortalAttendancePage({ params, searchParams }: { params: Promise<{ studentId: string }>; searchParams: Promise<{ month?: string | string[] }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  const m = (await searchParams).month;
  const data = await getPortalAttendanceMonth(ctx, { studentId, month: typeof m === "string" ? m : undefined }).catch((e: unknown) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound(); // review 6B-M1 L6: an edited role, too
    throw e;
  });
  if (!data) {
    return <p className="text-sm text-muted-foreground">No class enrollment yet. Attendance appears once the school places the student in a class.</p>;
  }
  const lead = (weekdayOf(data.days[0].date) + 6) % 7; // Monday-first grid
  const cells: (PortalAttendanceDay | null)[] = [...Array.from({ length: lead }, () => null), ...data.days];
  const base = `/portal/c/${encodeURIComponent(studentId)}/attendance`;
  const pct = (p: string | null) => (p === null ? "—" : `${p} %`);
  return (
    <div className="grid gap-4">
      <PageHeader title="Attendance" description={`${data.className} · Section ${data.sectionCode} · ${data.sessionName}`} />
      <div className="grid grid-cols-2 gap-3">
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <CardDescription>This session so far</CardDescription>
            <CardTitle className="text-2xl">{pct(data.sessionSummary.percent)}</CardTitle>
          </CardHeader>
          <CardContent className="px-4 text-xs text-muted-foreground">
            {data.sessionSummary.absent} absent of {data.sessionSummary.marked} marked days
          </CardContent>
        </Card>
        <Card className="gap-1 py-4">
          <CardHeader className="px-4">
            <CardDescription>{monthLabel(data.month)}</CardDescription>
            <CardTitle className="text-2xl">{pct(data.monthSummary.percent)}</CardTitle>
          </CardHeader>
          <CardContent className="px-4 text-xs text-muted-foreground">
            {data.monthSummary.absent} absent of {data.monthSummary.marked} marked days
          </CardContent>
        </Card>
      </div>
      <div className="flex items-center justify-between gap-2">
        {data.prevMonth ? (
          <Button asChild variant="outline">
            <Link href={`${base}?month=${data.prevMonth}`}>← {monthLabel(data.prevMonth)}</Link>
          </Button>
        ) : (
          <span />
        )}
        {data.nextMonth && (
          <Button asChild variant="outline">
            <Link href={`${base}?month=${data.nextMonth}`}>{monthLabel(data.nextMonth)} →</Link>
          </Button>
        )}
      </div>
      <table className="w-full table-fixed border-separate border-spacing-1 text-center text-sm">
        <caption className="sr-only">Attendance in {monthLabel(data.month)}</caption>
        <thead>
          <tr>
            {WEEK.map(([short, full]) => (
              <th key={short} scope="col" abbr={full} className="text-xs font-medium text-muted-foreground">
                {short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.ceil(cells.length / 7) }, (_, r) => (
            <tr key={r}>
              {cells.slice(r * 7, r * 7 + 7).map((d, i) => {
                if (!d) return <td key={`x${i}`} />;
                const t = dayText(d);
                return (
                  <td key={d.date} className={cn("h-12 rounded-md align-top", t.cls, d.date === data.today && "ring-2 ring-primary")} aria-current={d.date === data.today ? "date" : undefined}>
                    <span className="block text-xs">{Number(d.date.slice(8))}</span>
                    <span className="block text-xs font-semibold" aria-hidden="true">
                      {t.short}
                    </span>
                    <span className="sr-only">{t.label}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted-foreground">P present · L late · H half day · A absent · E excused · Hol holiday · Off weekly off · – not marked yet. Half days count as half.</p>
    </div>
  );
}
