import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ClipboardCheck, Pencil, Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly, formatDateTime, todayInTimeZone } from "@/lib/format";
import { canDo, SELF_APPROVAL_MESSAGE } from "@/modules/admissions/admissions.rules";
import { getApplication, guardianMatches, sectionChoices } from "@/modules/admissions/admissions.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { deleteDraftAction, startReviewAction } from "../actions";
import { DocumentsPanel } from "../documents-panel";
import { ApproveForm, ReasonForm, SectionForm } from "../forms";
import { addressText, Facts, GENDER_LABEL, RELATION_LABEL, StatusBadge, type Address, type PreviousSchool } from "../parts";

const SECTION_MISSING = "Assign and save a section above before approving.";

export const metadata = { title: "Admission application" };

const DOC_LABEL: Record<string, string> = { PHOTO: "Student photo", BIRTH_CERTIFICATE: "Birth certificate", TRANSFER_CERTIFICATE: "Transfer certificate", PREVIOUS_MARKSHEET: "Previous marksheet", OTHER: "Other document" };

export default async function AdmissionDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ submitted?: string; upload?: string }> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "admission.read")) return <NotPermitted />;
  const { id } = await params;
  const app = await getApplication(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const canCreate = hasPermission(ctx, "admission.create");
  const canApprove = hasPermission(ctx, "admission.approve");
  const r = { id: app.id, version: app.version };
  const reviewable = canApprove && canDo("setSection", app.status);
  const sections = reviewable ? await sectionChoices(ctx, id) : [];
  const matches = reviewable && app.sectionId ? await guardianMatches(ctx, id) : new Map<string, { id: string; name: string; students: string[] }[]>();
  const address = (app.address as Address) ?? null;
  const prev = (app.previousSchool as PreviousSchool) ?? null;
  const sp = await searchParams;
  const submittedNow = sp.submitted === "1";
  const tz = await getSchoolTimezone();
  const at = (d: Date) => formatDateTime(d, tz);

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <div>
        <Button asChild variant="ghost" className="-ml-2">
          <Link href="/erp/admissions">← Admissions</Link>
        </Button>
      </div>
      <PageHeader title={app.fullName} description={`${app.applicationNo ?? "Draft (no number yet)"} · ${app.class.name}${app.section ? ` · section ${app.section.name}` : ""} · ${app.academicSession.name}`} actions={<StatusBadge status={app.status} />} />

      {submittedNow && app.status === "SUBMITTED" && (
        <Alert role="status">
          <AlertDescription>Application submitted as {app.applicationNo}. An approver will review it.</AlertDescription>
        </Alert>
      )}
      {app.status === "APPROVED" && app.student && (
        <Alert role="status">
          <AlertDescription>
            Approved{app.decidedAt ? ` on ${at(app.decidedAt)}` : ""}. Student ID <span className="font-mono font-medium">{app.student.studentCode}</span>, admission number{" "}
            <span className="font-mono font-medium">{app.student.admissionNo}</span>
            {app.admissionDate ? `, admitted ${formatDateOnly(app.admissionDate)}` : ""}.
          </AlertDescription>
        </Alert>
      )}
      {app.status === "REJECTED" && (
        <Alert variant="destructive">
          <AlertDescription>Rejected{app.decidedAt ? ` on ${at(app.decidedAt)}` : ""}: {app.rejectionReason}</AlertDescription>
        </Alert>
      )}
      {app.duplicates.length > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>
            <p className="font-medium">Possible duplicate — same name and date of birth:</p>
            <ul className="mt-1 list-disc pl-5">
              {app.duplicates.map((d) => (
                <li key={`${d.kind}-${d.id}`}>
                  {d.label}
                  {d.strength === "strong" ? " (also a shared parent phone number)" : ""}
                </li>
              ))}
            </ul>
            <p className="mt-1">Approving it will require a written reason.</p>
          </AlertDescription>
        </Alert>
      )}
      {app.status !== "REJECTED" && app.missingDocuments.length > 0 && (
        <Alert>
          <AlertDescription>Documents pending: {app.missingDocuments.map((t) => DOC_LABEL[t] ?? t).join(", ")}. Missing documents don&apos;t block approval.</AlertDescription>
        </Alert>
      )}

      {app.status === "DRAFT" && canCreate && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Draft</h2>
            </CardTitle>
            <CardDescription>Complete every step, then submit from the last step.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button asChild className="w-full sm:w-auto">
              <Link href={`/erp/admissions/${id}/edit?step=1`}>
                <Pencil aria-hidden="true" /> Continue editing
              </Link>
            </Button>
            {!app.applicationNo && (
              <ConfirmAction
                label="Delete draft"
                icon={<Trash2 aria-hidden="true" />}
                variant="destructive"
                title="Delete this draft?"
                description="The draft and its guardian details are removed permanently. Submitted applications can't be deleted."
                confirmLabel="Delete draft"
                action={deleteDraftAction}
                fields={{ id: app.id, version: String(app.version) }}
              />
            )}
          </CardContent>
        </Card>
      )}

      {reviewable && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Review</h2>
            </CardTitle>
            <CardDescription>Assign the section the student will join, or send the application back or reject it. Every decision is recorded.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {app.status === "SUBMITTED" && (
              <ConfirmAction
                label="Start review"
                icon={<ClipboardCheck aria-hidden="true" />}
                title="Start reviewing this application?"
                description="It is marked Under review so others can see it is being handled."
                confirmLabel="Start review"
                action={startReviewAction}
                fields={{ id: app.id, version: String(app.version) }}
              />
            )}
            {sections.length === 0 ? (
              <p className="text-sm text-muted-foreground">This class has no sections in {app.academicSession.name} yet. Add them on the Classes → Sections screen.</p>
            ) : (
              <SectionForm
                r={r}
                current={app.sectionId ?? ""}
                sections={sections.map((s) => ({ value: s.id, label: `${s.name} (${s.code}) — ${s.enrolled}/${s.capacity} enrolled${s.isActive ? "" : ", inactive"}${s.enrolled >= s.capacity ? ", full" : ""}` }))}
              />
            )}
            <section aria-labelledby="approve-h" className="grid gap-3 rounded-lg border p-3">
              <h3 id="approve-h" className="text-base font-semibold">
                Approve & register
              </h3>
              {app.createdBy?.id === ctx.userId ? (
                <p className="text-sm text-muted-foreground" role="note">
                  {SELF_APPROVAL_MESSAGE}
                </p>
              ) : app.section ? (
                <ApproveForm
                  r={r}
                  today={todayInTimeZone(tz)}
                  sectionLabel={`${app.section.name} (${app.section.code})`}
                  needsOverride={app.duplicates.length > 0}
                  guardians={app.guardians.map((g) => ({ id: g.id, label: `${RELATION_LABEL[g.relation]}: ${g.name} · ${g.phone}`, matches: matches.get(g.id) ?? [] }))}
                />
              ) : (
                <p className="text-sm text-muted-foreground">{SECTION_MISSING}</p>
              )}
            </section>
            <div className="grid gap-6 md:grid-cols-2">
              <ReasonForm r={r} kind="return" />
              <ReasonForm r={r} kind="reject" />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Student</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Facts items={[["Name", app.fullName], ["Date of birth", formatDateOnly(app.dob)], ["Gender", GENDER_LABEL[app.gender]], ["Phone", app.phone], ["Email", app.email], ["Address", addressText(address)]]} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Parents / guardians</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {app.guardians.length === 0 ? (
            <p className="text-sm text-muted-foreground">None entered yet.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {app.guardians.map((g) => (
                <li key={g.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                  <span className="font-medium">
                    {g.name} <span className="font-normal text-muted-foreground">· {RELATION_LABEL[g.relation]}</span>
                  </span>
                  <span>{[g.phone, g.altPhone].filter(Boolean).join(" · ")}</span>
                  {g.email && <span className="break-all">{g.email}</span>}
                  {g.occupation && <span className="text-muted-foreground">{g.occupation}</span>}
                  <span className="text-muted-foreground">{[g.isPrimary && "Primary contact", g.isEmergencyContact && "Emergency contact"].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Photo & documents</h2>
          </CardTitle>
          <CardDescription>Private: stored encrypted and shown only to staff allowed to see admission documents. Every view is recorded.</CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentsPanel ctx={ctx} applicationId={app.id} status={app.status} from="detail" uploadCode={sp.upload} missing={app.status === "REJECTED" ? [] : app.missingDocuments} timeZone={tz} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Previous school</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {prev ? <Facts items={[["School", prev.name], ["Board", prev.board], ["Last class", prev.lastClass], ["Year left", prev.yearLeft], ["TC number", prev.tcNumber]]} /> : <p className="text-sm text-muted-foreground">None (first admission).</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>History</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Facts
            items={[
              ["Created", `${at(app.createdAt)}${app.createdBy ? ` by ${app.createdBy.displayName}` : ""}`],
              ["Submitted", app.submittedAt ? at(app.submittedAt) : null],
              ["Review started", app.reviewStartedAt ? at(app.reviewStartedAt) : null],
              ["Decided", app.decidedAt ? `${at(app.decidedAt)}${app.decidedBy ? ` by ${app.decidedBy.displayName}` : ""}` : null],
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
