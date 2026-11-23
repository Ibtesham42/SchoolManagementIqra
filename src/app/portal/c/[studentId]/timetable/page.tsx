import { notFound } from "next/navigation";
import { requirePortal } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { getPortalTimetable } from "@/modules/academic/timetable.portal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Timetable" };

/** Phase 6B-M1 (P12) — the child's weekly timetable, one card per day. */
export default async function PortalTimetablePage({ params }: { params: Promise<{ studentId: string }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  const data = await getPortalTimetable(ctx, studentId).catch((e: unknown) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound(); // review 6B-M1 L6: an edited role, too
    throw e;
  });
  if (!data) return <p className="text-sm text-muted-foreground">No class enrollment yet.</p>;
  return (
    <div className="grid gap-4">
      <PageHeader title="Timetable" description={`${data.className} · Section ${data.sectionCode} · ${data.sessionName}`} />
      {data.days.length === 0 && <p className="text-sm text-muted-foreground">The school hasn&apos;t published the timetable yet.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {data.days.map((d) => (
          <Card key={d.dayOfWeek} className="gap-2 py-4">
            <CardHeader className="px-4">
              <CardTitle>
                <h2>{d.name}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              <ol className="grid gap-2">
                {d.periods.map((p) => (
                  <li key={p.number} className="grid grid-cols-[4.5rem_1fr] gap-2 text-sm">
                    <span className="text-muted-foreground tabular-nums">
                      {p.start}–{p.end}
                    </span>
                    {p.kind === "BREAK" ? (
                      <span className="text-muted-foreground">{p.label ?? "Break"}</span>
                    ) : (
                      <span>
                        <span className="font-medium">{p.subject ?? "Free period"}</span>
                        {p.teacher && <span className="block text-xs text-muted-foreground">{p.teacher}</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
