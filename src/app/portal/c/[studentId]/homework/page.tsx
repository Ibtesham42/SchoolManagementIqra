import { notFound } from "next/navigation";
import { Paperclip } from "lucide-react";
import { requirePortal } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { listPortalHomework } from "@/modules/academic/homework.portal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Homework" };

const day = (iso: string) => formatDateOnly(new Date(`${iso}T00:00:00Z`));

/** Phase 6B-M2 (P12) — the child's homework: recent and upcoming, with attachments. */
export default async function PortalHomeworkPage({ params }: { params: Promise<{ studentId: string }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  const data = await listPortalHomework(ctx, studentId).catch((e: unknown) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  });
  if (!data) return <p className="text-sm text-muted-foreground">No class enrollment yet.</p>;
  return (
    <div className="grid gap-4">
      <PageHeader title="Homework" description={`${data.className} · Section ${data.sectionCode} · due in the last two weeks and later`} />
      {data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No homework right now.</p>
      ) : (
        <ul className="grid gap-2">
          {data.items.map((h) => (
            <li key={h.id}>
              <Card className="py-3">
                <CardContent className="grid gap-2 px-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{h.subject}</Badge>
                    <span className="text-sm text-muted-foreground">
                      Due {day(h.dueOn)}
                      {h.dueOn < data.today ? " (past)" : h.dueOn === data.today ? " (today)" : ""}
                    </span>
                  </div>
                  <p className="font-medium">{h.title}</p>
                  <p className="whitespace-pre-line text-sm">{h.details}</p>
                  <p className="text-xs text-muted-foreground">Set on {day(h.assignedOn)}</p>
                  {h.hasAttachment && (
                    <Button asChild variant="outline" className="w-full sm:w-auto sm:justify-self-start">
                      <a href={`/api/v1/portal/homework/${encodeURIComponent(h.id)}/attachment`}>
                        <Paperclip aria-hidden="true" />
                        Open attachment
                      </a>
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
