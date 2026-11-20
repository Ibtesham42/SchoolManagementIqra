import Link from "next/link";
import { Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly, todayInTimeZone } from "@/lib/format";
import { calendarMonthSchema } from "@/modules/academic/calendar.schemas";
import { calendarAccess, getCalendarMonth } from "@/modules/academic/calendar.service";
import { examAccess } from "@/modules/academic/examinations.service";
import { listSessionsForSections } from "@/modules/academic/sections.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { deleteEventAction } from "../actions";
import { academicTabFlags } from "../tab-flags";
import { EventForm } from "./event-form";

export const metadata = { title: "Academic calendar" };

const KIND = { holiday: "Holiday", exam: "Exam", exam_subject: "Exam paper", event: "Event" } as const;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
function shift(month: string, by: number) {
  const [y, m] = month.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + by, 1));
  return t.toISOString().slice(0, 7);
}
const monthLabel = (month: string) => new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(d(`${month}-01`));

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const access = calendarAccess(ctx);
  if (!access.read) return <NotPermitted />;
  const sp = await searchParams;
  const today = todayInTimeZone(await getSchoolTimezone());
  const { sessions, currentId } = await listSessionsForSections(ctx).catch(() => ({ sessions: [], currentId: null }));
  const session = sessions.find((s) => s.id === sp.session) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];
  const asked = typeof sp.month === "string" ? sp.month : today.slice(0, 7);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : today.slice(0, 7);
  const data = session ? await getCalendarMonth(ctx, calendarMonthSchema.parse({ academicSessionId: session.id, month })) : null;
  const linkExams = examAccess(ctx).read;
  const q = (m: string) => `/erp/academic/calendar?session=${session?.id ?? ""}&month=${m}`;
  const NAV = "inline-flex min-h-11 items-center rounded-lg border px-4 text-sm font-medium hover:bg-muted pointer-fine:min-h-9";

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Academic calendar" description="Student holidays, exam dates and school events. Separate from the public website's events." />
      <AcademicTabs current="calendar" {...academicTabFlags(ctx)} />
      {!data ? (
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      ) : (
        <>
          <nav aria-label="Month" className="flex flex-wrap items-center justify-between gap-2">
            <Link href={q(shift(month, -1))} className={NAV}>
              Previous month
            </Link>
            <h2 className="text-lg font-semibold">
              {monthLabel(month)} · {data.session.name}
            </h2>
            <Link href={q(shift(month, 1))} className={NAV}>
              Next month
            </Link>
          </nav>
          <Card>
            <CardContent className="pt-6">
              {data.entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing on the calendar this month.</p>
              ) : (
                <ul className="grid gap-2">
                  {data.entries.map((e, i) => (
                    <li key={`${e.kind}-${e.date}-${i}`} className="grid gap-2 rounded-lg border p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-medium">
                          {e.kind !== "event" && e.kind !== "holiday" && linkExams ? (
                            <Link href={`/erp/academic/exams/${e.examId}`} className="underline">
                              {e.title}
                            </Link>
                          ) : (
                            e.title
                          )}
                        </span>
                        <span className="flex items-center gap-2 text-sm text-muted-foreground">
                          {formatDateOnly(d(e.date))}
                          {e.endDate !== e.date ? ` – ${formatDateOnly(d(e.endDate))}` : ""}
                          <Badge variant={e.kind === "holiday" ? "secondary" : "default"}>{KIND[e.kind]}</Badge>
                        </span>
                      </div>
                      {e.kind === "event" && e.details && <p className="text-sm whitespace-pre-line">{e.details}</p>}
                      {e.kind === "event" && access.manage && data.session.status !== "CLOSED" && (
                        <div className="flex flex-wrap items-start gap-2">
                          <details className="grow rounded-lg border p-3 open:pb-4">
                            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Edit</summary>
                            <div className="mt-3">
                              <EventForm defaults={{ id: e.id, version: e.version, title: e.title, startDate: e.date, endDate: e.endDate, details: e.details ?? "" }} min={data.session.startDate} max={data.session.endDate} />
                            </div>
                          </details>
                          <ConfirmAction label="Remove" variant="destructive" icon={<Trash2 aria-hidden="true" />} title={`Remove ${e.title}?`} description="The event is taken off the calendar." confirmLabel="Remove" action={deleteEventAction} fields={{ id: e.id, version: String(e.version) }} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          {access.manage && data.session.status !== "CLOSED" && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Add an event</h2>
                </CardTitle>
                <CardDescription>
                  Within {data.session.name}. Holidays are managed under Staff → Holidays; exam dates come from each exam.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EventForm defaults={{ academicSessionId: data.session.id, title: "", startDate: "", endDate: "", details: "" }} min={data.session.startDate} max={data.session.endDate} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
