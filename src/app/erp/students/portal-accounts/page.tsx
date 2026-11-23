import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { isPortalSlipCode, PORTAL_SLIP_MESSAGES } from "@/lib/http/portal-slip-errors";
import { hasPermission } from "@/lib/rbac/authorize";
import { listSections, listSessionsForSections } from "@/modules/academic/sections.service";
import { canManageFamilyAccess, listSectionFamilyAccess, type FamilyAccountStatus } from "@/modules/students/family-accounts.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SelectField } from "@/components/erp/form";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Parent portal accounts" };

const STATUS: Record<FamilyAccountStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  NONE: { label: "No account", variant: "outline" },
  PENDING: { label: "Slip issued", variant: "secondary" },
  EXPIRED: { label: "Code expired", variant: "outline" },
  ACTIVE: { label: "Active", variant: "default" },
  DEACTIVATED: { label: "Deactivated", variant: "destructive" },
};

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Phase 6A-M3 (ADR-046) — parent portal accounts per section: each studying student's primary guardian and its
 * account state, and one button that creates the missing accounts and prints their activation slips (PDF).
 */
export default async function PortalAccountsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireAuth();
  if (!canManageFamilyAccess(ctx) || !hasPermission(ctx, "academic.read")) return <NotPermitted />;
  const sp = await searchParams;
  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === one(sp.session)) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];
  const sections = session ? await listSections(ctx, { academicSessionId: session.id }) : [];
  const sectionId = sections.some((s) => s.id === one(sp.section)) ? one(sp.section) : "";
  const list = sectionId
    ? await listSectionFamilyAccess(ctx, sectionId).catch((e: unknown) => {
        if (e instanceof NotFoundError || e instanceof ValidationError) return e;
        throw e;
      })
    : null;
  const slips = one(sp.slips);

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <p className="text-sm">
        <Link href="/erp/students" className="text-muted-foreground underline-offset-4 hover:underline">
          ← Students
        </Link>
      </p>
      <PageHeader
        title="Parent portal accounts"
        description="Create accounts for the primary guardians of a section and print their activation slips. Parents activate with the slip, their child's date of birth and their own password. Other guardians: from the student's profile."
      />
      {isPortalSlipCode(slips) && (
        <Alert variant={slips === "none" ? "default" : "destructive"} role="alert">
          <AlertDescription>{PORTAL_SLIP_MESSAGES[slips]}</AlertDescription>
        </Alert>
      )}
      {!session ? (
        <Alert>
          <AlertDescription>No academic session exists yet.</AlertDescription>
        </Alert>
      ) : (
        <form method="get" className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <SelectField label="Academic session" name="session" defaultValue={session.id} options={sessions.map((s) => ({ value: s.id, label: `${s.name}${s.id === currentId ? " · current" : ""}` }))} />
          <SelectField label="Section" name="section" defaultValue={sectionId} options={[{ value: "", label: "Choose a section" }, ...sections.map((s) => ({ value: s.id, label: `${s.class.name} ${s.code}` }))]} />
          <Button type="submit" variant="outline" className="w-full sm:w-auto">
            Show
          </Button>
        </form>
      )}
      {list instanceof Error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{list.message}</AlertDescription>
        </Alert>
      )}
      {list && !(list instanceof Error) && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>
                {list.section.label} · {list.section.sessionName}
              </h2>
            </CardTitle>
            <CardDescription>{list.rows.length} studying students. Brothers and sisters share one parent account.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form method="post" action="/api/v1/portal-accounts/slips" className="grid gap-3 rounded-lg border p-3">
              <input type="hidden" name="target" value="section" />
              <input type="hidden" name="sectionId" value={list.section.id} />
              <div className="flex min-h-11 items-center gap-3">
                <Checkbox id="reissuePending" name="reissuePending" />
                <Label htmlFor="reissuePending" className="font-normal">
                  Also print new slips for accounts not activated yet (their old codes stop working)
                </Label>
              </div>
              <Button type="submit" className="w-full sm:w-auto">
                Create missing accounts and print slips
              </Button>
              <p className="text-xs text-muted-foreground">The codes appear only in the downloaded PDF. Hand each slip to its parent, or send it home in a sealed envelope.</p>
            </form>
            <Table className="hidden md:table">
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Primary guardian</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Username</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((r) => (
                  <TableRow key={r.studentId}>
                    <TableCell>
                      <Link href={`/erp/students/${r.studentId}#family`} className="underline-offset-4 hover:underline">
                        {r.fullName}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{r.studentCode}</span>
                    </TableCell>
                    <TableCell>{r.guardianName ?? "—"}</TableCell>
                    <TableCell>{r.status ? <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge> : "No primary guardian"}</TableCell>
                    <TableCell className="font-mono text-sm">{r.username ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ul className="grid gap-2 md:hidden">
              {list.rows.map((r) => (
                <li key={r.studentId} className="rounded-lg border p-3">
                  <Link href={`/erp/students/${r.studentId}#family`} className="flex min-h-11 flex-col justify-center font-medium underline-offset-4 hover:underline">
                    {r.fullName}
                    <span className="text-xs font-normal text-muted-foreground">{r.studentCode}</span>
                  </Link>
                  <p className="text-sm text-muted-foreground">{r.guardianName ?? "No primary guardian"}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {r.status && <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>}
                    {r.username && <span className="font-mono text-sm">{r.username}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
