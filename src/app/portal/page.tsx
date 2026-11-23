import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { requirePortal } from "@/lib/auth/context";
import { listPortalChildren, portalWindow } from "@/modules/students/students.portal";
import { portalOverdueChildren } from "@/modules/fees/fees.portal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Portal" };

/** Phase 6A-M2 — portal home: the children this account can see (a student account: its own record). */
export default async function PortalHomePage() {
  const ctx = await requirePortal();
  const window = await portalWindow(); // one settings read for the whole page (review 6B-M3 info)
  const kids = await listPortalChildren(ctx, window);
  const isStudent = ctx.portal.kind === "STUDENT";
  // FC22 in-app (P23): a live "dues overdue" banner — no reminder emails or jobs.
  const overdue = isStudent ? 0 : await portalOverdueChildren(ctx, window);
  return (
    <div className="grid gap-4">
      <PageHeader title={`Welcome, ${ctx.displayName}`} description={isStudent ? "Your school record." : "Your children at this school."} />
      {overdue > 0 && (
        <Alert variant="destructive" role="status">
          <AlertDescription>Fees are overdue for {overdue === 1 ? "one of your children" : `${overdue} of your children`}. Open the child&apos;s Fees tab to see what is due.</AlertDescription>
        </Alert>
      )}
      {kids.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{isStudent ? "No linked record" : "No linked children"}</CardTitle>
            <CardDescription>
              {isStudent
                ? "Your account isn't linked to a student record. Please contact the school office."
                : "No students are linked to your account. Please contact the school office."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {kids.map((k) => (
            <li key={k.id}>
              <Card className="py-0">
                <CardContent className="p-0">
                  {k.current ? (
                    <Link href={`/portal/c/${encodeURIComponent(k.id)}/profile`} className="flex min-h-16 items-center justify-between gap-3 rounded-xl px-4 py-3 hover:bg-muted">
                      <ChildLine name={k.fullName} detail={[k.className && `Class ${k.className}`, k.sectionCode && `Section ${k.sectionCode}`].filter(Boolean).join(" · ") || k.studentCode} />
                      <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  ) : (
                    <Link href={`/portal/c/${encodeURIComponent(k.id)}/results`} className="flex min-h-16 items-center justify-between gap-3 rounded-xl px-4 py-3 hover:bg-muted">
                      <ChildLine name={k.fullName} detail="Left school. Report cards stay available for a while." />
                      <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Link>
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

function ChildLine({ name, detail }: { name: string; detail: string }) {
  return (
    <span className="grid min-w-0">
      <span className="truncate font-medium">{name}</span>
      <span className="text-sm text-muted-foreground">{detail}</span>
    </span>
  );
}
