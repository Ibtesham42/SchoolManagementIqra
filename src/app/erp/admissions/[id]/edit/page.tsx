import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly, toDateInputValue } from "@/lib/format";
import { missingForSubmission } from "@/modules/admissions/admissions.rules";
import { admissionFormOptions, getApplication } from "@/modules/admissions/admissions.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { ContactStepForm, GuardiansStepForm, PreviousSchoolForm, StudentStepForm, SubmitApplicationForm, type GuardianSlot } from "../../forms";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { DocumentsPanel } from "../../documents-panel";
import { addressText, DOCUMENTS_STEP, Facts, GENDER_LABEL, RELATION_LABEL, StatusBadge, StepNav, STEPS, type Address, type PreviousSchool } from "../../parts";

export const metadata = { title: "Edit admission" };

const EMPTY_SLOT: GuardianSlot = { name: "", phone: "", altPhone: "", email: "", occupation: "", emergency: false };

export default async function EditAdmissionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ step?: string | string[]; upload?: string | string[] }> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "admission.create")) return <NotPermitted />;
  const { id } = await params;
  const sp = await searchParams;
  const rawStep = sp.step;
  const step = Math.min(STEPS.length, Math.max(1, Number(typeof rawStep === "string" ? rawStep : "1") || 1));

  const app = await getApplication(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const r = { id: app.id, version: app.version };
  const back = step > 1 ? `/erp/admissions/${id}/edit?step=${step - 1}` : `/erp/admissions/${id}`;
  const header = (
    <>
      <div>
        <Button asChild variant="ghost" className="-ml-2">
          <Link href={`/erp/admissions/${id}`}>← Application</Link>
        </Button>
      </div>
      <PageHeader title={app.fullName} description={`${app.applicationNo ?? "Draft"} · ${app.class.name} · ${app.academicSession.name}`} actions={<StatusBadge status={app.status} />} />
    </>
  );

  if (app.status !== "DRAFT") {
    return (
      <div className="mx-auto grid max-w-3xl gap-4">
        {header}
        <Alert>
          <AlertDescription>Only drafts can be edited. An approver can return this application to draft for corrections.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const address = (app.address as Address) ?? null;
  const prev = (app.previousSchool as PreviousSchool) ?? null;
  let body: React.ReactNode;
  if (step === 1) {
    const { sessions, classes } = await admissionFormOptions(ctx);
    body = (
      <StudentStepForm
        r={r}
        defaults={{ academicSessionId: app.academicSessionId, classId: app.classId, firstName: app.firstName, middleName: app.middleName ?? "", lastName: app.lastName ?? "", dob: toDateInputValue(app.dob), gender: app.gender }}
        sessions={sessions.map((s) => ({ value: s.id, label: s.name }))}
        classes={classes.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))}
      />
    );
  } else if (step === 2) {
    const byRel = (rel: string) => app.guardians.find((g) => g.relation === rel);
    const other = app.guardians.find((g) => g.relation === "GUARDIAN" || g.relation === "OTHER");
    const slot = (g: (typeof app.guardians)[number] | undefined): GuardianSlot =>
      g ? { name: g.name, phone: g.phone, altPhone: g.altPhone ?? "", email: g.email ?? "", occupation: g.occupation ?? "", emergency: g.isEmergencyContact, relation: g.relation } : EMPTY_SLOT;
    const slots = [slot(byRel("FATHER")), slot(byRel("MOTHER")), slot(other)];
    const primaryRel = app.guardians.find((g) => g.isPrimary)?.relation;
    const primary = primaryRel === "FATHER" ? "0" : primaryRel === "MOTHER" ? "1" : primaryRel ? "2" : "";
    body = <GuardiansStepForm r={r} slots={slots} primary={primary} back={back} />;
  } else if (step === 3) {
    body = (
      <ContactStepForm
        r={r}
        back={back}
        defaults={{ phone: app.phone ?? "", email: app.email ?? "", line1: address?.line1 ?? "", line2: address?.line2 ?? "", city: address?.city ?? "", district: address?.district ?? "", state: address?.state ?? "", pinCode: address?.pinCode ?? "", country: address?.country ?? "India" }}
      />
    );
  } else if (step === 4) {
    body = <PreviousSchoolForm r={r} back={back} defaults={{ schoolName: prev?.name ?? "", board: prev?.board ?? "", lastClass: prev?.lastClass ?? "", yearLeft: prev?.yearLeft ?? "", tcNumber: prev?.tcNumber ?? "" }} />;
  } else if (step === DOCUMENTS_STEP) {
    body = (
      <div className="grid gap-4">
        <DocumentsPanel ctx={ctx} applicationId={id} status={app.status} from="edit" uploadCode={typeof sp.upload === "string" ? sp.upload : undefined} missing={app.missingDocuments} timeZone={await getSchoolTimezone()} />
        <div className="sticky bottom-16 z-10 -mx-4 flex flex-col-reverse gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:justify-between lg:bottom-0">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href={back}>Back</Link>
          </Button>
          <Button asChild className="w-full sm:w-auto">
            <Link href={`/erp/admissions/${id}/edit?step=${DOCUMENTS_STEP + 1}`}>Continue to review</Link>
          </Button>
        </div>
      </div>
    );
  } else {
    const missing = missingForSubmission({ guardians: app.guardians, address: app.address });
    body = (
      <div className="grid gap-4">
        {missing.length > 0 ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              <p className="font-medium">Complete these before submitting:</p>
              <ul className="mt-1 list-disc pl-5">
                {missing.map((m) => (
                  <li key={m.message}>
                    <Link className="underline" href={`/erp/admissions/${id}/edit?step=${m.step}`}>
                      {m.message}
                    </Link>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <AlertDescription>Check the details. After submitting, the application gets its number and goes to an approver; it can no longer be edited unless it is returned to draft.</AlertDescription>
          </Alert>
        )}
        <section className="grid gap-2" aria-labelledby="r-student">
          <h2 id="r-student" className="text-base font-semibold">Student</h2>
          <Facts items={[["Name", app.fullName], ["Date of birth", formatDateOnly(app.dob)], ["Gender", GENDER_LABEL[app.gender]], ["Class · session", `${app.class.name} · ${app.academicSession.name}`]]} />
        </section>
        <section className="grid gap-2" aria-labelledby="r-guardians">
          <h2 id="r-guardians" className="text-base font-semibold">Parents / guardians</h2>
          {app.guardians.length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : (
            <ul className="grid gap-2 text-sm">
              {app.guardians.map((g) => (
                <li key={g.id} className="rounded-lg border p-3">
                  <span className="font-medium">{g.name}</span> · {RELATION_LABEL[g.relation]} · {g.phone}
                  {g.isPrimary ? " · primary contact" : ""}
                  {g.isEmergencyContact ? " · emergency contact" : ""}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="grid gap-2" aria-labelledby="r-contact">
          <h2 id="r-contact" className="text-base font-semibold">Contact & address</h2>
          <Facts items={[["Address", addressText(address)], ["Student's phone", app.phone], ["Student's email", app.email]]} />
        </section>
        <section className="grid gap-2" aria-labelledby="r-docs">
          <h2 id="r-docs" className="text-base font-semibold">Photo & documents</h2>
          <p className="text-sm">
            {app.documents.length} document{app.documents.length === 1 ? "" : "s"} uploaded
            {app.missingDocuments.length ? ` · still needed: ${app.missingDocuments.length} (doesn't block submission or approval)` : ""}.
          </p>
        </section>
        <section className="grid gap-2" aria-labelledby="r-prev">
          <h2 id="r-prev" className="text-base font-semibold">Previous school</h2>
          <Facts items={[["School", prev?.name], ["Board", prev?.board], ["Last class", prev?.lastClass], ["Year left", prev?.yearLeft], ["TC number", prev?.tcNumber]]} />
        </section>
        <SubmitApplicationForm r={r} back={back} disabled={missing.length > 0} />
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      {header}
      <StepNav id={id} current={step} />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>
              Step {step} of {STEPS.length}: {STEPS[step - 1]}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
    </div>
  );
}
