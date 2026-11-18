import Link from "next/link";
import { notFound } from "next/navigation";
import { ListOrdered } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { getRollNumberSheet } from "@/modules/students/roll-numbers.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { generateRollNumbersAction } from "../actions";
import { CorrectionForm, FinalizeForm } from "../forms";

export const metadata = { title: "Section roll numbers" };

const ROLL_PERMISSIONS: PermissionKey[] = ["rollnumber.generate", "rollnumber.finalize", "rollnumber.correct"];
const SOURCE_LABEL = { GENERATED: null, APPENDED: "Added later", CORRECTED: "Corrected" } as const;

type Row = { key: string; rollNumber: number | null; studentCode: string; fullName: string; note?: string | null; left?: boolean };

/** Table from md up, cards below — rendered once per page (no duplicate ids). */
function RollTable({ rows, caption }: { rows: Row[]; caption: string }) {
  return (
    <>
      <table className="hidden w-full text-sm md:table">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-left text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="w-24 py-2 pr-3 font-medium">Roll no.</th>
            <th scope="col" className="py-2 pr-3 font-medium">Student</th>
            <th scope="col" className="py-2 pr-3 font-medium">Student ID</th>
            <th scope="col" className="py-2 font-medium"><span className="sr-only">Notes</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b last:border-0">
              <td className="py-2 pr-3 font-mono text-base font-semibold">{r.rollNumber ?? "—"}</td>
              <td className="py-2 pr-3">{r.fullName}</td>
              <td className="py-2 pr-3 font-mono text-xs">{r.studentCode}</td>
              <td className="py-2">{r.note && <Badge variant="outline">{r.note}</Badge>}{r.left && <Badge variant="secondary">Left</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="grid gap-2 md:hidden" aria-label={caption}>
        {rows.map((r) => (
          <li key={r.key} className="flex items-center gap-3 rounded-lg border p-3">
            <span className="w-10 text-center font-mono text-lg font-semibold">{r.rollNumber ?? "—"}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{r.fullName}</span>
              <span className="font-mono text-xs text-muted-foreground">{r.studentCode}</span>
            </span>
            {r.note && <Badge variant="outline">{r.note}</Badge>}
            {r.left && <Badge variant="secondary">Left</Badge>}
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function SectionRollNumbersPage({ params }: { params: Promise<{ sectionId: string }> }) {
  const ctx = await requireAuth();
  if (!ROLL_PERMISSIONS.some((p) => hasPermission(ctx, p))) return <NotPermitted />;
  const { sectionId } = await params;
  const sheet = await getRollNumberSheet(ctx, sectionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const { section, batch, preview, draftIsCurrent } = sheet;
  const tz = await getSchoolTimezone();
  const closed = section.academicSession.status === "CLOSED";
  const canGenerate = hasPermission(ctx, "rollnumber.generate") && !closed && batch?.status !== "FINALIZED";
  const canFinalize = hasPermission(ctx, "rollnumber.finalize") && !closed && batch?.status === "DRAFT";
  const canCorrect = hasPermission(ctx, "rollnumber.correct") && !closed && batch?.status === "FINALIZED";

  const assigned: Row[] = (batch?.numbers ?? []).map((n) => ({
    key: n.enrollmentId,
    rollNumber: n.rollNumber,
    studentCode: n.enrollment.student.studentCode,
    fullName: n.enrollment.student.fullName,
    note: SOURCE_LABEL[n.source],
    left: n.enrollment.status !== "ACTIVE",
  }));
  const previewRows: Row[] = preview.map((p) => ({ key: p.enrollmentId, rollNumber: p.rollNumber, studentCode: p.studentCode, fullName: p.fullName }));

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <div>
        <Button asChild variant="ghost" className="-ml-2">
          <Link href="/erp/students/registration">← Roll numbers</Link>
        </Button>
      </div>
      <PageHeader
        title={`${section.class.name} · Section ${section.name}`}
        description={`${section.code} · ${section.academicSession.name} · ${preview.length}/${section.capacity} active students`}
        actions={batch ? <Badge variant={batch.status === "FINALIZED" ? "default" : "secondary"}>{batch.status === "FINALIZED" ? "Finalized" : "Draft"}</Badge> : <Badge variant="outline">Not generated</Badge>}
      />
      {closed && (
        <Alert>
          <AlertDescription>Session {section.academicSession.name} is closed. Roll numbers are read-only.</AlertDescription>
        </Alert>
      )}

      {batch?.status === "FINALIZED" ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Final roll numbers</h2>
            </CardTitle>
            <CardDescription>
              Finalized {batch.finalizedAt ? formatDateTime(batch.finalizedAt, tz) : ""}
              {batch.finalizedBy ? ` by ${batch.finalizedBy.displayName}` : ""}. Students admitted later were given the next number.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <RollTable rows={assigned} caption="Final roll numbers" />
            {canCorrect && (
              <section aria-labelledby="correct-h" className="grid gap-2 rounded-lg border p-3">
                <h3 id="correct-h" className="text-base font-semibold">Correct a roll number</h3>
                <CorrectionForm sectionId={section.id} version={batch.version} students={assigned.map((a) => ({ value: a.key, label: `${a.rollNumber} — ${a.fullName} (${a.studentCode})` }))} />
              </section>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{batch ? "Draft roll numbers" : "Preview"}</h2>
              </CardTitle>
              <CardDescription>
                {batch
                  ? `Generated ${formatDateTime(batch.generatedAt, tz)}${batch.generatedBy ? ` by ${batch.generatedBy.displayName}` : ""}.`
                  : "Alphabetical by full name; same names ordered by date of birth (older first), then student ID. Nothing is saved yet."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {batch && draftIsCurrent === false && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>Students or names changed since this draft was generated. Generate it again before finalizing. The current order is shown under Preview.</AlertDescription>
                </Alert>
              )}
              {preview.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active students in this section yet. Approved admissions appear here.</p>
              ) : (
                <RollTable rows={batch ? assigned : previewRows} caption={batch ? "Draft roll numbers" : "Preview"} />
              )}
              {canGenerate && preview.length > 0 && (
                <ConfirmAction
                  label={batch ? "Generate the draft again" : "Generate draft"}
                  icon={<ListOrdered aria-hidden="true" />}
                  title={batch ? "Replace the draft?" : "Generate draft roll numbers?"}
                  description="Numbers are saved as a draft in alphabetical order. A draft can be regenerated until it is finalized."
                  confirmLabel="Generate"
                  action={generateRollNumbersAction}
                  fields={{ sectionId: section.id, version: batch ? String(batch.version) : "" }}
                />
              )}
            </CardContent>
          </Card>
          {batch && draftIsCurrent === false && preview.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Preview (current order)</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <RollTable rows={previewRows} caption="Current preview" />
              </CardContent>
            </Card>
          )}
          {canFinalize && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Finalize</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <FinalizeForm sectionId={section.id} version={batch!.version} sectionCode={section.code} stale={draftIsCurrent === false} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
