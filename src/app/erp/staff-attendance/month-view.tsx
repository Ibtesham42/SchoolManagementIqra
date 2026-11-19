import Link from "next/link";
import { formatDateOnly } from "@/lib/format";
import { ATTENDANCE_STATUS_LABEL, ATTENDANCE_STATUS_SHORT, shiftMonth, type MonthSummary } from "@/modules/hr/staff-attendance.rules";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CorrectDayForm } from "./mark-forms";

export interface MonthDay {
  date: string;
  kind: "working" | "weekly_off" | "holiday";
  onRolls: boolean;
  holidayName: string | null;
  mark: {
    status: string;
    label: string;
    checkIn: string | null;
    checkOut: string | null;
    version: number;
    corrected: boolean;
    correctionReason: string | null;
    leave: { code: string; name: string } | null;
  } | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const monthTitle = (month: string) => d(`${month}-01`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

function cellText(day: MonthDay, today: string): { short: string; label: string } {
  if (day.mark) return { short: ATTENDANCE_STATUS_SHORT[day.mark.status] ?? "?", label: day.mark.label };
  if (day.kind === "holiday") return { short: "H", label: day.holidayName ? `Holiday: ${day.holidayName}` : "Holiday" };
  if (day.kind === "weekly_off") return { short: "WO", label: "Weekly off" };
  if (!day.onRolls) return { short: "", label: "Not on the staff rolls" };
  if (day.date > today) return { short: "", label: "Not yet" };
  return { short: "–", label: "Not marked" };
}

export function SummaryList({ s }: { s: MonthSummary }) {
  const items: [string, number][] = [
    ["Working days so far", s.workingDays],
    ["Present", s.present],
    ["Late", s.late],
    ["Half day", s.halfDay],
    ["On leave", s.onLeave],
    ["Half-day leave", s.halfDayLeave],
    ["Absent", s.absent],
    ["Not marked", s.unmarked],
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
      {items.map(([label, n]) => (
        <div key={label} className="rounded-lg border p-2">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-medium tabular-nums">{n}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Month calendar (7 columns fit 360 px) + a day list with times, leave and corrections; optional correction forms. */
export function MonthView({
  month,
  today,
  days,
  summary,
  locked,
  basePath,
  canMark,
  employeeId,
}: {
  month: string;
  today: string;
  days: MonthDay[];
  summary: MonthSummary;
  locked: boolean;
  basePath: string;
  canMark: boolean;
  employeeId: string;
}) {
  const lead = d(days[0].date).getUTCDay();
  const sep = basePath.includes("?") ? "&" : "?";
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const editable = (day: MonthDay) =>
    canMark && !locked && day.kind === "working" && day.onRolls && day.date <= today && !(day.mark && day.mark.leave);
  return (
    <>
      <nav aria-label="Month" className="flex items-center justify-between gap-2">
        <Link href={`${basePath}${sep}month=${prev}`} className="flex min-h-11 items-center rounded-lg border px-3 text-sm">
          ← {monthTitle(prev)}
        </Link>
        <h2 className="text-base font-medium">{monthTitle(month)}</h2>
        {next <= today.slice(0, 7) ? (
          <Link href={`${basePath}${sep}month=${next}`} className="flex min-h-11 items-center rounded-lg border px-3 text-sm">
            {monthTitle(next)} →
          </Link>
        ) : (
          <span />
        )}
      </nav>
      {locked && <p className="rounded-lg border p-3 text-sm">This month is locked for payroll. Marks can&apos;t be changed.</p>}
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Summary</h3>
          </CardTitle>
          <CardDescription>Counts working days up to today while on the staff rolls.</CardDescription>
        </CardHeader>
        <CardContent>
          <SummaryList s={summary} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Calendar</h3>
          </CardTitle>
          <CardDescription>
            P present · A absent · L late · ½ half day · LV leave · H holiday · WO weekly off · – not marked
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol aria-label={`Attendance, ${monthTitle(month)}`} className="grid grid-cols-7 gap-1 text-center text-xs">
            {WEEKDAYS.map((w) => (
              <li key={w} aria-hidden="true" className="py-1 font-medium text-muted-foreground">
                {w}
              </li>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <li key={`pad-${i}`} aria-hidden="true" />
            ))}
            {days.map((day) => {
              const t = cellText(day, today);
              return (
                <li
                  key={day.date}
                  aria-current={day.date === today ? "date" : undefined}
                  className="flex min-h-11 flex-col items-center justify-center rounded-md border aria-[current=date]:border-primary aria-[current=date]:border-2 data-[off=true]:bg-muted data-[absent=true]:border-destructive"
                  data-off={day.kind !== "working" || !day.onRolls}
                  data-absent={day.mark?.status === "ABSENT"}
                >
                  <span className="sr-only">{`${formatDateOnly(d(day.date))}: ${t.label}`}</span>
                  <span aria-hidden="true" className="text-muted-foreground">
                    {Number(day.date.slice(8))}
                  </span>
                  <span aria-hidden="true" className="font-medium">
                    {t.short}
                  </span>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h3>Days</h3>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2">
            {days
              .filter((day) => day.mark || editable(day) || day.kind === "holiday")
              .map((day) => (
                <li key={day.date} className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{formatDateOnly(d(day.date))}</span>
                    <span className="flex flex-wrap gap-1">
                      {day.mark ? (
                        <Badge variant={day.mark.status === "ABSENT" ? "destructive" : "outline"}>{day.mark.label}</Badge>
                      ) : day.kind === "holiday" ? (
                        <Badge variant="secondary">Holiday</Badge>
                      ) : (
                        <Badge variant="secondary">Not marked</Badge>
                      )}
                      {day.mark?.corrected && <Badge variant="secondary">Corrected</Badge>}
                    </span>
                  </div>
                  {day.kind === "holiday" && day.holidayName && <p className="text-muted-foreground">{day.holidayName}</p>}
                  {day.mark?.leave && (
                    <p className="text-muted-foreground">
                      {day.mark.leave.name} ({day.mark.leave.code})
                    </p>
                  )}
                  {(day.mark?.checkIn || day.mark?.checkOut) && (
                    <p className="text-muted-foreground">
                      In {day.mark.checkIn ?? "—"} · Out {day.mark.checkOut ?? "—"}
                    </p>
                  )}
                  {day.mark?.correctionReason && <p className="text-muted-foreground">Correction: {day.mark.correctionReason}</p>}
                  {editable(day) && (
                    <details className="rounded-lg border p-3">
                      <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">
                        {day.mark ? "Correct" : "Mark"} ({ATTENDANCE_STATUS_LABEL[day.mark?.status ?? "PRESENT"]})
                      </summary>
                      <div className="mt-3">
                        <CorrectDayForm
                          date={day.date}
                          row={{
                            id: employeeId,
                            employeeCode: "",
                            fullName: formatDateOnly(d(day.date)),
                            subtitle: "",
                            status: day.mark?.status ?? null,
                            checkIn: day.mark?.checkIn ?? null,
                            checkOut: day.mark?.checkOut ?? null,
                            version: day.mark?.version ?? null,
                          }}
                        />
                      </div>
                    </details>
                  )}
                </li>
              ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
