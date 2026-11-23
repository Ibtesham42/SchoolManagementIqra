import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { requirePortal } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { listPortalReportCards } from "@/modules/academic/results.portal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Report cards" };

const RESULT: Record<string, string> = { PASS: "Passed", FAIL: "Not passed", NO_RESULT: "No result" };

/** Phase 6B-M2 (P11) — the child's published report cards (all sessions), each as a PARENT COPY PDF. */
export default async function PortalResultsPage({ params }: { params: Promise<{ studentId: string }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  const cards = await listPortalReportCards(ctx, studentId).catch((e: unknown) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  });
  return (
    <div className="grid gap-4">
      <PageHeader title="Report cards" description="Results appear here once the school publishes them." />
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">No report cards have been published yet.</p>
      ) : (
        <ul className="grid gap-2">
          {cards.map((c) => (
            <li key={c.id}>
              <Card className="py-3">
                <CardContent className="flex flex-col gap-3 px-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="grid gap-1">
                    <p className="font-medium">{c.examName}</p>
                    <p className="text-sm text-muted-foreground">
                      {c.sessionName} · published {formatDateOnly(new Date(`${c.publishedOn}T00:00:00Z`))}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {c.result && <Badge variant={c.result === "PASS" ? "default" : "secondary"}>{RESULT[c.result]}</Badge>}
                      {c.percent && <Badge variant="outline">{c.percent} %</Badge>}
                    </div>
                  </div>
                  <Button asChild variant="outline" className="w-full sm:w-auto">
                    <a href={`/api/v1/portal/report-cards/${encodeURIComponent(c.id)}/pdf`} download>
                      <Download aria-hidden="true" />
                      Download (PDF)
                    </a>
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
