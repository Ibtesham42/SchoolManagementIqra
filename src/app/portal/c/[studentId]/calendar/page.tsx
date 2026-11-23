import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePortal } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { getPortalCalendarMonth } from "@/modules/academic/calendar.portal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Calendar" };

const KIND: Record<string, string> = { holiday: "Holiday", exam: "Exams", exam_subject: "Exam", event: "Event" };
const day = (iso: string) => formatDateOnly(new Date(`${iso}T00:00:00Z`));
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });

/** Phase 6B-M1 (P12) — the academic calendar for the child's class: holidays, exams and school events by month. */
export default async function PortalCalendarPage({ params, searchParams }: { params: Promise<{ studentId: string }>; searchParams: Promise<{ month?: string | string[] }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  const m = (await searchParams).month;
  const data = await getPortalCalendarMonth(ctx, { studentId, month: typeof m === "string" ? m : undefined }).catch((e: unknown) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound(); // review 6B-M1 L6: an edited role, too
    throw e;
  });
  if (!data) return <p className="text-sm text-muted-foreground">No class enrollment yet.</p>;
  const base = `/portal/c/${encodeURIComponent(studentId)}/calendar`;
  return (
    <div className="grid gap-4">
      <PageHeader title={monthLabel(data.month)} description={`School calendar · ${data.sessionName}`} />
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
      {data.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing on the calendar this month.</p>
      ) : (
        <ul className="grid gap-2">
          {data.entries.map((e, i) => (
            <li key={`${e.kind}-${e.date}-${i}`}>
              <Card className="py-3">
                <CardContent className="grid gap-1 px-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={e.kind === "holiday" ? "secondary" : e.kind === "event" ? "outline" : "default"}>{KIND[e.kind]}</Badge>
                    <span className="text-sm text-muted-foreground">{e.endDate !== e.date ? `${day(e.date)} – ${day(e.endDate)}` : day(e.date)}</span>
                  </div>
                  <p className="font-medium">{e.title}</p>
                  {e.details && <p className="text-sm text-muted-foreground">{e.details}</p>}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
