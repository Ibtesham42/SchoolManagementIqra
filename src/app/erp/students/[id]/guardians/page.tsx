import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { canLinkGuardians, findGuardiansByPhone, guardianSearchSchema } from "@/modules/students/guardian-links.service";
import { getFamilyAccess } from "@/modules/students/family-accounts.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/components/erp/form";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { LinkGuardianForm, MergeButton } from "./forms";

export const metadata = { title: "Link or merge guardians" };

/**
 * Phase 6A-M3b (P18) — the same parent recorded twice: find guardian records by mobile number, link one to this
 * student, or merge two records that share the number (School Admin / Super Admin).
 */
export default async function GuardianLinksPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ phone?: string | string[] }> }) {
  const ctx = await requireAuth();
  if (!canLinkGuardians(ctx)) return <NotPermitted />;
  const { id } = await params;
  const phoneParam = (await searchParams).phone;
  const phone = typeof phoneParam === "string" ? phoneParam.replace(/\D/g, "").slice(-10) : "";
  // The student must exist (and the caller manage family access); the list itself isn't needed here.
  await getFamilyAccess(ctx, id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const search = phone ? guardianSearchSchema.safeParse({ studentId: id, phone }) : null;
  const matches = search?.success ? await findGuardiansByPhone(ctx, search.data) : null;
  // This student's own guardian records with the same number: the merge partners for every other record found.
  const linkedHere = matches?.filter((g) => g.linkedHere) ?? [];

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <p className="text-sm">
        <Link href={`/erp/students/${id}#family`} className="text-muted-foreground underline-offset-4 hover:underline">
          ← Back to the student
        </Link>
      </p>
      <PageHeader title="Link or merge guardians" description="When a parent was recorded again at a sibling's admission, link the existing record or merge the two, so one parent account sees all their children." />
      <form method="get" className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <TextField label="Parent's mobile number" name="phone" defaultValue={phone} inputMode="numeric" autoComplete="off" hint="10 digits." />
        <Button type="submit" variant="outline" className="w-full sm:w-auto">
          Find records
        </Button>
      </form>
      {search && !search.success && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Enter the 10-digit mobile number.</AlertDescription>
        </Alert>
      )}
      {matches && matches.length === 0 && <p className="text-sm text-muted-foreground">No guardian records with this number.</p>}
      {matches?.map((g) => {
        return (
          <Card key={g.id}>
            <CardHeader>
              <CardTitle>
                <h2 className="flex flex-wrap items-center gap-2">
                  {g.name}
                  {g.linkedHere && <Badge variant="secondary">Linked to this student</Badge>}
                  {g.hasAccount && <Badge>Has a portal account</Badge>}
                  {g.blockedHere && <Badge variant="destructive">Blocked from this student</Badge>}
                </h2>
              </CardTitle>
              <CardDescription>
                Mobile {g.phoneHint}. {g.students.length ? `Guardian of: ${g.students.join("; ")}` : "Not linked to any student."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {!g.linkedHere && <LinkGuardianForm studentId={id} guardianId={g.id} />}
              {linkedHere.length > 0 && !g.linkedHere && (
                <div className="grid gap-2">
                  <p className="text-sm font-medium">Or merge with this student&apos;s guardian (same mobile number only):</p>
                  {linkedHere.map((c) => (
                    <div key={c.id} className="grid gap-2 rounded-lg border p-3">
                      <p className="text-sm">
                        {c.name} (this student) and {g.name} (found)
                      </p>
                      {!g.hasAccount && <MergeButton studentId={id} keepGuardianId={c.id} removeGuardianId={g.id} keepName={c.name} removeName={g.name} different={c.name.trim().toLowerCase() !== g.name.trim().toLowerCase()} />}
                      {!c.hasAccount && <MergeButton studentId={id} keepGuardianId={g.id} removeGuardianId={c.id} keepName={g.name} removeName={c.name} different={c.name.trim().toLowerCase() !== g.name.trim().toLowerCase()} />}
                      {g.hasAccount && c.hasAccount && <p className="text-sm text-muted-foreground">Both have a portal account: deactivate one first, then merge into the other.</p>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
