import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { isPortalSlipCode, PORTAL_SLIP_MESSAGES } from "@/lib/http/portal-slip-errors";
import type { getFamilyAccess, getStudentAccount, FamilyAccountStatus } from "@/modules/students/family-accounts.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/erp/form";
import { AccountActiveForm, InviteByEmailForm, PortalAccessToggle, StudentAccountActiveForm } from "./family-access-forms";

const RELATION: Record<string, string> = { FATHER: "Father", MOTHER: "Mother", GUARDIAN: "Guardian", OTHER: "Other" };
const STATUS: Record<FamilyAccountStatus, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  NONE: { label: "No account", variant: "outline" },
  PENDING: { label: "Slip issued, not activated", variant: "secondary" },
  EXPIRED: { label: "Code expired, not activated", variant: "outline" },
  ACTIVE: { label: "Active", variant: "default" },
  DEACTIVATED: { label: "Deactivated", variant: "destructive" },
};
const SLIP_ROUTE = "/api/v1/portal-accounts/slips";

/**
 * Phase 6A-M3 — "Family access" on the student profile (`portal.account.manage` + `student.read` ALL). Slips are
 * plain form POSTs to the PDF route (the code exists only in the downloaded PDF).
 */
export function FamilyAccess({
  studentId,
  guardians,
  student,
  slips,
  timeZone,
  canLink,
}: {
  studentId: string;
  guardians: Awaited<ReturnType<typeof getFamilyAccess>>;
  student: Awaited<ReturnType<typeof getStudentAccount>>;
  slips?: string;
  timeZone: string;
  canLink: boolean;
}) {
  return (
    <Card id="family">
      <CardHeader>
        <CardTitle>
          <h2>Family access (parent portal)</h2>
        </CardTitle>
        <CardDescription>Issue a parent account with a printed activation slip (or an emailed invitation), print a new slip, block a guardian from this student, or deactivate an account.</CardDescription>
        {canLink && (
          <p className="text-sm">
            <Link href={`/erp/students/${studentId}/guardians`} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
              Same parent recorded twice? Link or merge guardians
            </Link>
          </p>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {isPortalSlipCode(slips) && (
          <Alert variant={slips === "none" ? "default" : "destructive"} role="alert">
            <AlertDescription>{PORTAL_SLIP_MESSAGES[slips]}</AlertDescription>
          </Alert>
        )}
        {guardians.length === 0 && <p className="text-sm text-muted-foreground">No guardians recorded.</p>}
        <ul className="grid gap-4">
          {guardians.map((g) => {
            const status = g.account?.status ?? "NONE";
            return (
              <li key={g.guardianId} className="grid gap-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{g.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {RELATION[g.relation] ?? g.relation}
                    {g.isPrimary ? " · primary" : ""}
                  </span>
                  <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
                  {!g.portalAccess && <Badge variant="destructive">Blocked from this student</Badge>}
                </div>
                {g.account && (
                  <p className="text-sm text-muted-foreground">
                    Username <span className="font-mono text-foreground">{g.account.username}</span>
                    {g.account.activatedAt ? ` · activated ${formatDateTime(g.account.activatedAt, timeZone)}` : ""}
                    {status === "PENDING" && g.account.codeExpiresAt ? ` · code valid until ${formatDateTime(g.account.codeExpiresAt, timeZone)}` : ""}
                  </p>
                )}
                {!g.account ? (
                  <form method="post" action={SLIP_ROUTE} className="grid gap-2 sm:max-w-md">
                    <input type="hidden" name="target" value="guardian" />
                    <input type="hidden" name="mode" value="create" />
                    <input type="hidden" name="studentId" value={studentId} />
                    <input type="hidden" name="guardianId" value={g.guardianId} />
                    <TextField id={`username-${g.guardianId}`} label="Username" name="username" defaultValue={g.suggestedUsername ?? ""} autoCapitalize="none" spellCheck={false} hint="The mobile number by default. 3–50 letters, digits, dot, dash or underscore." />
                    <Button type="submit" className="w-full sm:w-auto">
                      Create account and print slip
                    </Button>
                  </form>
                ) : (
                  status !== "DEACTIVATED" && (
                    <details className="rounded-lg bg-muted/50 p-3">
                      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">Print a new slip…</summary>
                      <form method="post" action={SLIP_ROUTE} className="mt-2 grid gap-2">
                        <input type="hidden" name="target" value="guardian" />
                        <input type="hidden" name="mode" value="reset" />
                        <input type="hidden" name="studentId" value={studentId} />
                        <input type="hidden" name="guardianId" value={g.guardianId} />
                        <p className="text-sm text-muted-foreground">
                          For a lost slip, an expired code or a forgotten password. The old code{g.account.activatedAt ? " and the current password stop" : " stops"} working at once and the
                          account is signed out everywhere.
                        </p>
                        <Button type="submit" variant="outline" className="w-full sm:w-auto">
                          Print a new slip
                        </Button>
                      </form>
                    </details>
                  )
                )}
                {g.email && g.portalAccess && !g.account?.everActivated && (status === "NONE" || status === "PENDING" || status === "EXPIRED") && (
                  <InviteByEmailForm studentId={studentId} guardianId={g.guardianId} email={g.email} needsUsername={!g.account} suggestedUsername={g.suggestedUsername} />
                )}
                <div className="flex flex-col gap-3">
                  <PortalAccessToggle studentId={studentId} guardianId={g.guardianId} portalAccess={g.portalAccess} name={g.name} />
                  {g.account && <AccountActiveForm studentId={studentId} guardianId={g.guardianId} active={status !== "DEACTIVATED"} />}
                </div>
              </li>
            );
          })}
        </ul>
        <StudentAccount studentId={studentId} student={student} timeZone={timeZone} />
      </CardContent>
    </Card>
  );
}

/** Phase 6C-M4 (P14) — the student's own account: only when the school turned it on; the slip goes to the parent. */
function StudentAccount({ studentId, student, timeZone }: { studentId: string; student: Awaited<ReturnType<typeof getStudentAccount>>; timeZone: string }) {
  if (!student.enabled && !student.account) return null;
  const status = student.account?.status ?? "NONE";
  return (
    <section className="grid gap-3 rounded-lg border border-dashed p-3" aria-labelledby={`student-account-${studentId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`student-account-${studentId}`} className="font-medium">
          Student&apos;s own account
        </h3>
        <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">Report cards, attendance, homework, timetable and notices for the student; never fees. Print the slip for the parent, who decides when to give it to the child.</p>
      {student.account && (
        <p className="text-sm text-muted-foreground">
          Username <span className="font-mono text-foreground">{student.account.username}</span>
          {student.account.activatedAt ? ` · activated ${formatDateTime(student.account.activatedAt, timeZone)}` : ""}
          {status === "PENDING" && student.account.codeExpiresAt ? ` · code valid until ${formatDateTime(student.account.codeExpiresAt, timeZone)}` : ""}
        </p>
      )}
      {student.problem && status !== "DEACTIVATED" ? (
        <p className="text-sm" role="note">
          {student.problem}
        </p>
      ) : !student.account ? (
        <form method="post" action={SLIP_ROUTE} className="grid gap-2 sm:max-w-md">
          <input type="hidden" name="target" value="student" />
          <input type="hidden" name="mode" value="create" />
          <input type="hidden" name="studentId" value={studentId} />
          <TextField id={`username-student-${studentId}`} label="Username" name="username" defaultValue={student.suggestedUsername ?? ""} autoCapitalize="none" spellCheck={false} hint="The Student ID in lower case by default." />
          <Button type="submit" className="w-full sm:w-auto">
            Create student account and print slip
          </Button>
        </form>
      ) : (
        status !== "DEACTIVATED" && (
          <form method="post" action={SLIP_ROUTE} className="grid gap-2 sm:max-w-md">
            <input type="hidden" name="target" value="student" />
            <input type="hidden" name="mode" value="reset" />
            <input type="hidden" name="studentId" value={studentId} />
            <Button type="submit" variant="outline" className="w-full sm:w-auto">
              Print a new slip for the student&apos;s account
            </Button>
          </form>
        )
      )}
      {student.account && <StudentAccountActiveForm studentId={studentId} active={status !== "DEACTIVATED"} />}
    </section>
  );
}
