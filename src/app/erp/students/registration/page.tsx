import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { listSessionsForSections } from "@/modules/academic/sections.service";
import { listSectionsForRollNumbers } from "@/modules/students/roll-numbers.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectField } from "@/components/erp/form";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Roll numbers" };

const ROLL_PERMISSIONS: PermissionKey[] = ["rollnumber.generate", "rollnumber.finalize", "rollnumber.correct"];
const canUse = (ctx: Awaited<ReturnType<typeof requireAuth>>) => ROLL_PERMISSIONS.some((p) => hasPermission(ctx, p));

function RollStatus({ status }: { status: "DRAFT" | "FINALIZED" | null }) {
  if (status === "FINALIZED") return <Badge variant="default">Finalized</Badge>;
  if (status === "DRAFT") return <Badge variant="secondary">Draft</Badge>;
  return <Badge variant="outline">Not generated</Badge>;
}

/** Registration & roll numbers: every section of a session with its enrolled count and roll-number status. */
export default async function RollNumbersPage({ searchParams }: { searchParams: Promise<{ session?: string | string[] }> }) {
  const ctx = await requireAuth();
  if (!canUse(ctx) || !hasPermission(ctx, "academic.read")) return <NotPermitted />;
  const { sessions, currentId } = await listSessionsForSections(ctx);
  const requested = (await searchParams).session;
  const session = sessions.find((s) => s.id === (typeof requested === "string" ? requested : "")) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Roll numbers" description="Per section and session, alphabetical by student name. Generate a draft, check it, then finalize. Finalized numbers never change automatically; later admissions get the next number." />
      {!session ? (
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      ) : (
        <>
          <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-72">
              <SelectField label="Academic session" name="session" defaultValue={session.id} options={sessions.map((s) => ({ value: s.id, label: `${s.name}${s.id === currentId ? " · current" : ""}` }))} />
            </div>
            <Button type="submit" variant="outline" className="w-full sm:w-auto">
              Show
            </Button>
          </form>
          <SectionList sessionId={session.id} sessionName={session.name} ctx={ctx} />
        </>
      )}
    </div>
  );
}

async function SectionList({ sessionId, sessionName, ctx }: { sessionId: string; sessionName: string; ctx: Awaited<ReturnType<typeof requireAuth>> }) {
  const sections = await listSectionsForRollNumbers(ctx, sessionId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Sections in {sessionName}</h2>
        </CardTitle>
        <CardDescription>{sections.length === 0 ? "No sections in this session." : `${sections.length} section${sections.length === 1 ? "" : "s"}.`}</CardDescription>
      </CardHeader>
      {sections.length > 0 && (
        <CardContent>
          <ul className="grid gap-2">
            {sections.map((s) => (
              <li key={s.id}>
                <Link href={`/erp/students/registration/${s.id}`} className="grid min-h-11 gap-1 rounded-lg border p-3 hover:bg-muted sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-4">
                  <span className="font-medium">
                    {s.class.name} · Section {s.name} <span className="font-mono text-xs text-muted-foreground">{s.code}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {s.enrolled}/{s.capacity} students
                  </span>
                  <RollStatus status={s.rollNumberBatch?.status ?? null} />
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
