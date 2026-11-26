import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, UserMinus } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatBytes } from "@/lib/storage/upload-limits";
import { formatDateOnly, formatDateTime } from "@/lib/format";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { STUDENT_STATUS_LABEL } from "@/modules/students/students.rules";
import { canBrowseStudents, getStudent } from "@/modules/students/students.service";
import { canManageFamilyAccess, getFamilyAccess, getStudentAccount } from "@/modules/students/family-accounts.service";
import { canLinkGuardians } from "@/modules/students/guardian-links.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { addressText, Facts, GENDER_LABEL, RELATION_LABEL, type Address, type PreviousSchool } from "../../admissions/parts";
import { StudentStatusBadge } from "../parts";
import { FamilyAccess } from "./family-access";

export const metadata = { title: "Student" };

const DOC_LABEL: Record<string, string> = {
  PHOTO: "Student photo",
  BIRTH_CERTIFICATE: "Birth certificate",
  TRANSFER_CERTIFICATE: "Transfer certificate",
  PREVIOUS_MARKSHEET: "Previous marksheet",
  OTHER: "Other document",
};
const ENROLLMENT_LABEL: Record<string, string> = { ACTIVE: "Studying", PROMOTED: "Promoted", DETAINED: "Detained", LEFT: "Left" };
const SECTIONS = [
  ["overview", "Overview"],
  ["guardians", "Guardians"],
  ["family", "Family access"],
  ["history", "Academic history"],
  ["documents", "Documents"],
  ["status", "Status history"],
] as const;

type Search = Record<string, string | string[] | undefined>;

export default async function StudentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const ctx = await requireAuth();
  if (!canBrowseStudents(ctx)) return <NotPermitted />;
  const { id } = await params;
  const sp = await searchParams;
  const s = await getStudent(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound(); // also for students outside the caller's scope
    throw e;
  });

  const current = s.enrollments.find((e) => e.status === "ACTIVE") ?? s.enrollments[0] ?? null;
  const canEdit = hasPermission(ctx, "student.update") && ["ALL", "ASSIGNED"].includes(scopeFor(ctx, "student.update") ?? "");
  const canChangeStatus = hasPermission(ctx, "student.transfer") && s.status === "ACTIVE";
  const prev = s.previousSchool as PreviousSchool;
  // Phase 6A-M3: parent portal accounts (School Admin / Super Admin).
  const [family, studentAccount] = canManageFamilyAccess(ctx) ? await Promise.all([getFamilyAccess(ctx, s.id), getStudentAccount(ctx, s.id)]) : [null, null];
  const timeZone = family ? await getSchoolTimezone() : undefined;
  const shownSections = SECTIONS.filter(([key]) => (key !== "documents" || s.documents !== null) && (key !== "family" || family !== null));

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <p className="text-sm">
        <Link href="/erp/students" className="text-muted-foreground underline-offset-4 hover:underline">
          ← Students
        </Link>
      </p>
      {sp.saved === "1" && (
        <Alert role="status">
          <AlertDescription>Changes saved.</AlertDescription>
        </Alert>
      )}
      {sp.status === "1" && (
        <Alert role="status">
          <AlertDescription>Leaving recorded. The student is now {STUDENT_STATUS_LABEL[s.status].toLowerCase()}.</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="size-24 shrink-0 overflow-hidden rounded-lg border bg-muted">
          {s.hasPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element -- private, authorized route; not optimisable by next/image
            <img src={`/api/v1/students/${s.id}/photo`} alt={`Photo of ${s.fullName}`} className="size-full object-cover" />
          ) : (
            <span className="flex size-full items-center justify-center p-2 text-center text-xs text-muted-foreground">No photo</span>
          )}
        </div>
        <div className="grid flex-1 gap-2">
          <PageHeader
            title={s.fullName}
            description={`${s.studentCode} · Admission no. ${s.admissionNo}${current ? ` · ${current.section.class.name} ${current.section.name} (${current.academicSession.name})` : ""}${current?.rollNumber ? ` · Roll ${current.rollNumber.rollNumber}` : ""}`}
            actions={
              canEdit || canChangeStatus ? (
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                  {canEdit && (
                    <Button asChild variant="outline" className="w-full sm:w-auto">
                      <Link href={`/erp/students/${s.id}/edit`}>
                        <Pencil aria-hidden="true" /> Edit
                      </Link>
                    </Button>
                  )}
                  {canChangeStatus && (
                    <Button asChild variant="outline" className="w-full sm:w-auto">
                      <Link href={`/erp/students/${s.id}/status`}>
                        <UserMinus aria-hidden="true" /> Record leaving
                      </Link>
                    </Button>
                  )}
                </div>
              ) : undefined
            }
          />
          <p>
            <StudentStatusBadge status={s.status} />
          </p>
        </div>
      </div>

      <nav aria-label="Profile sections" className="flex gap-1 overflow-x-auto pb-1">
        {shownSections.map(([key, label]) => (
          <a key={key} href={`#${key}`} className="flex min-h-11 shrink-0 items-center rounded-lg border px-3 text-sm hover:bg-muted pointer-fine:min-h-9">
            {label}
          </a>
        ))}
      </nav>

      <Card id="overview">
        <CardHeader>
          <CardTitle>
            <h2>Overview</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          <Facts
            items={[
              ["Student ID", s.studentCode],
              ["Admission number", s.admissionNo],
              ["Date of birth", formatDateOnly(s.dob)],
              ["Gender", GENDER_LABEL[s.gender]],
              ["Admission date", formatDateOnly(s.admissionDate)],
              ["Admitted in session", s.admittedSession.name],
              ["Phone", s.phone],
              ["Email", s.email],
            ]}
          />
          <Facts items={[["Home address", addressText(s.address as Address)]]} />
          {prev && (
            <Facts
              items={[
                ["Previous school", prev.name],
                ["Board", prev.board],
                ["Last class", prev.lastClass],
                ["Year left", prev.yearLeft],
                ["TC number", prev.tcNumber],
              ]}
            />
          )}
          {s.application && (
            <p className="text-sm">
              Registered from admission application{" "}
              <Link href={`/erp/admissions/${s.application.id}`} className="font-medium underline underline-offset-4">
                {s.application.applicationNo ?? "(application)"}
              </Link>
              {s.application.decidedAt ? `, approved on ${formatDateTime(s.application.decidedAt)}` : ""}.
            </p>
          )}
        </CardContent>
      </Card>

      <Card id="guardians">
        <CardHeader>
          <CardTitle>
            <h2>Parents / guardians</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {s.guardians.length === 0 ? (
            <p className="text-sm text-muted-foreground">No guardians recorded.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {s.guardians.map((g) => (
                <li key={g.guardian.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                  <span className="font-medium">
                    {g.guardian.name} <span className="font-normal text-muted-foreground">· {RELATION_LABEL[g.relation]}</span>
                  </span>
                  <span>
                    <a href={`tel:${g.guardian.phone}`} className="underline-offset-4 hover:underline">
                      {g.guardian.phone}
                    </a>
                    {g.guardian.altPhone ? ` · ${g.guardian.altPhone}` : ""}
                  </span>
                  {g.guardian.email && <span className="break-all">{g.guardian.email}</span>}
                  {g.guardian.occupation && <span className="text-muted-foreground">{g.guardian.occupation}</span>}
                  <span className="text-xs text-muted-foreground">
                    {[g.isPrimary ? "Primary contact" : null, g.isEmergencyContact ? "Emergency contact" : null, g.guardian._count.students > 1 ? `Guardian of ${g.guardian._count.students} students` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {family && studentAccount && <FamilyAccess studentId={s.id} guardians={family} student={studentAccount} slips={typeof sp.slips === "string" ? sp.slips : undefined} timeZone={timeZone!} canLink={canLinkGuardians(ctx)} />}

      <Card id="history">
        <CardHeader>
          <CardTitle>
            <h2>Academic history</h2>
          </CardTitle>
          <CardDescription>One entry per academic session. Earlier sessions are never overwritten.</CardDescription>
        </CardHeader>
        <CardContent>
          <table className="hidden w-full text-sm md:table">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b">
                <th scope="col" className="py-2 pr-3 font-medium">Session</th>
                <th scope="col" className="py-2 pr-3 font-medium">Class · section</th>
                <th scope="col" className="py-2 pr-3 font-medium">Roll no.</th>
                <th scope="col" className="py-2 pr-3 font-medium">Dates</th>
                <th scope="col" className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {s.enrollments.map((e) => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="py-3 pr-3">{e.academicSession.name}</td>
                  <td className="py-3 pr-3">
                    {e.section.class.name} · {e.section.name}
                  </td>
                  <td className="py-3 pr-3">{e.rollNumber ? `${e.rollNumber.rollNumber}${e.rollNumber.source === "APPENDED" ? " (added later)" : ""}` : "Not assigned"}</td>
                  <td className="py-3 pr-3">
                    {formatDateOnly(e.enrolledOn)}
                    {e.leftOn ? ` – ${formatDateOnly(e.leftOn)}` : ""}
                  </td>
                  <td className="py-3">{ENROLLMENT_LABEL[e.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="grid gap-3 md:hidden">
            {s.enrollments.map((e) => (
              <li key={e.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                <span className="flex justify-between gap-2 font-medium">
                  {e.academicSession.name} <span className="font-normal">{ENROLLMENT_LABEL[e.status]}</span>
                </span>
                <span>
                  {e.section.class.name} · {e.section.name}
                  {e.rollNumber ? ` · Roll ${e.rollNumber.rollNumber}` : ""}
                </span>
                <span className="text-muted-foreground">
                  {formatDateOnly(e.enrolledOn)}
                  {e.leftOn ? ` – ${formatDateOnly(e.leftOn)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {s.documents !== null && (
        <Card id="documents">
          <CardHeader>
            <CardTitle>
              <h2>Documents</h2>
            </CardTitle>
            <CardDescription>Private files. Every download is recorded in the audit log.</CardDescription>
          </CardHeader>
          <CardContent>
            {s.documents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No documents.</p>
            ) : (
              <ul className="grid gap-2">
                {s.documents.map((d) => (
                  <li key={d.id} className="flex flex-col gap-1 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <span>
                      <span className="font-medium">{d.label ?? DOC_LABEL[d.type]}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatBytes(d.file.sizeBytes)} · {d.verifiedAt ? `Verified${d.verifiedBy ? ` by ${d.verifiedBy.displayName}` : ""}` : "Not verified"}
                      </span>
                    </span>
                    <a href={`/api/v1/students/${s.id}/documents/${d.id}`} className="inline-flex min-h-11 items-center underline underline-offset-4 pointer-fine:min-h-9">
                      {d.file.mimeType === "application/pdf" ? "Download" : "View"}
                      <span className="sr-only"> {d.label ?? DOC_LABEL[d.type]}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <Card id="status">
        <CardHeader>
          <CardTitle>
            <h2>Status history</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {s.statusChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">Active since admission on {formatDateOnly(s.admissionDate)}. No status changes.</p>
          ) : (
            <ol className="grid gap-3">
              {s.statusChanges.map((c) => (
                <li key={c.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                  <span className="font-medium">
                    {STUDENT_STATUS_LABEL[c.fromStatus]} → {STUDENT_STATUS_LABEL[c.toStatus]} on {formatDateOnly(c.effectiveDate)}
                  </span>
                  <span className="break-words">{c.reason}</span>
                  <span className="text-xs text-muted-foreground">
                    Recorded {formatDateTime(c.createdAt)}
                    {c.actedBy ? ` by ${c.actedBy.displayName}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
