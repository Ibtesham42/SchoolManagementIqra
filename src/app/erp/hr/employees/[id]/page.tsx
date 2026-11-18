import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { canBrowseEmployees, canManageEmployees, canViewOwnProfile, isOwnRecord } from "@/modules/hr/hr.policy";
import { APPOINTMENT_TYPE_LABEL, EMPLOYMENT_STATUS_LABEL, SERVICE_EVENT_LABEL, STAFF_TYPE_LABEL, type EmploymentStatus } from "@/modules/hr/hr.rules";
import { getEmployee } from "@/modules/hr/employees.service";
import { staffAccountPanel } from "@/modules/hr/staff-accounts.service";
import { listServiceHistory } from "@/modules/hr/employee-lifecycle.service";
import { hasEmployeePhoto, listEmployeeDocuments } from "@/modules/hr/employee-documents.service";
import { hasPermission } from "@/lib/rbac/authorize";
import { getTeacherProfile } from "@/modules/hr/teacher-profiles.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { StatusBadge } from "../parts";
import { DocumentsCard } from "./documents-card";
import { LinkAccountForm, UnlinkAccount } from "./account-panel";
import { TeacherProfileForm, type ProfessionalQualification, type Qualification } from "./teacher-profile-form";

export const metadata = { title: "Employee" };

type Search = Record<string, string | string[] | undefined>;
const GENDER_LABEL = { MALE: "Male", FEMALE: "Female", OTHER: "Other" } as const;

interface Address {
  line1?: string;
  line2?: string | null;
  city?: string;
  district?: string | null;
  state?: string;
  pinCode?: string;
  country?: string;
}
interface EmergencyContact {
  name?: string;
  relation?: string;
  phone?: string;
}
const asObject = <T,>(v: unknown): T | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null);

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const ctx = await requireAuth();
  const { id } = await params;
  // Directory readers see any record; everyone else only their own linked record ("My profile", H7).
  const browse = canBrowseEmployees(ctx);
  if (!browse && !(canViewOwnProfile(ctx) && isOwnRecord(ctx, id))) return <NotPermitted />;
  const sp = await searchParams;
  const e = await getEmployee(ctx, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const canEdit = canManageEmployees(ctx) && e.tier === "personal";
  const isTeaching = e.staffType === "TEACHING";
  const [teacher, account, history, docs, hasPhoto] = await Promise.all([
    isTeaching ? getTeacherProfile(ctx, e.id) : Promise.resolve(null),
    browse ? staffAccountPanel(ctx, e.id) : Promise.resolve(null),
    listServiceHistory(ctx, e.id),
    listEmployeeDocuments(ctx, e.id),
    hasEmployeePhoto(ctx, e.id),
  ]);
  const canManageDocs = browse && hasPermission(ctx, "employee.document.manage") && e.tier === "personal";
  const qualifications = (Array.isArray(teacher?.qualifications) ? teacher.qualifications : []) as unknown as Qualification[];
  const professional = (Array.isArray(teacher?.professionalQualifications) ? teacher.professionalQualifications : []) as unknown as ProfessionalQualification[];

  const address = e.tier === "personal" ? asObject<Address>(e.address) : null;
  const emergency = e.tier === "personal" ? asObject<EmergencyContact>(e.emergencyContact) : null;

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title={e.fullName}
        description={`${e.employeeCode} · ${e.designation.name} · ${e.department.name}`}
        actions={
          canEdit ? (
            <div className="flex w-full flex-col gap-2 sm:w-fit sm:flex-row">
              <Button asChild variant="outline">
                <Link href={`/erp/hr/employees/${e.id}/edit`}>
                  <Pencil aria-hidden="true" /> Edit details
                </Link>
              </Button>
              {!(isOwnRecord(ctx, e.id) && !ctx.isSuperAdmin) && (
                <Button asChild variant="outline">
                  <Link href={`/erp/hr/employees/${e.id}/status`}>Change status</Link>
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {sp.registered === "1" && (
        <Alert role="status">
          <AlertDescription>
            Registered with employee ID <span className="font-mono font-semibold">{e.employeeCode}</span>. This ID never changes.
          </AlertDescription>
        </Alert>
      )}
      <p>
        <Link href={browse ? "/erp/hr/employees" : "/erp/account"} className="text-sm underline-offset-4 hover:underline">
          {browse ? "← All staff" : "← My account"}
        </Link>
      </p>
      {isOwnRecord(ctx, e.id) && !canManageEmployees(ctx) && <p className="text-sm text-muted-foreground">This is your staff record. Ask the HR office to correct anything that is wrong.</p>}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Overview</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-[auto_1fr]">
          <div className="flex size-32 items-center justify-center overflow-hidden rounded-lg border bg-muted text-xs text-muted-foreground">
            {hasPhoto ? (
              // eslint-disable-next-line @next/next/no-img-element -- private, authorized route; not optimisable by next/image
              <img src={`/api/v1/employees/${e.id}/photo`} alt={`Photo of ${e.fullName}`} className="size-full object-cover" />
            ) : (
              "No photo"
            )}
          </div>
          <Rows
            rows={[
              ["Employee ID", <span key="c" className="font-mono">{e.employeeCode}</span>],
              ["Status", <StatusBadge key="s" status={e.employmentStatus} />],
              ["Staff type", STAFF_TYPE_LABEL[e.staffType]],
              ["Designation", e.designation.name],
              ["Department", e.department.name],
              [
                "Reports to",
                e.reportsTo ? (
                  <Link key="r" href={`/erp/hr/employees/${e.reportsTo.id}`} className="underline-offset-4 hover:underline">
                    {e.reportsTo.fullName} ({e.reportsTo.employeeCode})
                  </Link>
                ) : (
                  "Nobody"
                ),
              ],
              ["Work phone", e.workPhone],
              ["Work email", e.workEmail],
            ]}
          />
        </CardContent>
      </Card>

      {e.tier === "personal" ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Employment</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Rows
                rows={[
                  ["Appointment type", APPOINTMENT_TYPE_LABEL[e.appointmentType]],
                  ["Joining date", formatDateOnly(e.joiningDate)],
                  ["Confirmation date", e.confirmationDate ? formatDateOnly(e.confirmationDate) : null],
                  ...(e.leavingDate ? ([["Leaving date", formatDateOnly(e.leavingDate)], ["Leaving reason", e.leavingReason]] as [string, React.ReactNode][]) : []),
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Personal details</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Rows
                rows={[
                  ["Date of birth", formatDateOnly(e.dob)],
                  ["Gender", GENDER_LABEL[e.gender]],
                  ["Personal phone", e.personalPhone],
                  ["Personal email", e.personalEmail],
                  ["Home address", address ? [address.line1, address.line2, address.city, address.district, address.state, address.pinCode, address.country].filter(Boolean).join(", ") : null],
                  ["Emergency contact", emergency ? `${emergency.name} (${emergency.relation}) · ${emergency.phone}` : null],
                ]}
              />
            </CardContent>
          </Card>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Personal details are visible only to staff with permission to view them.</p>
      )}

      {isTeaching && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Teacher profile</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {teacher ? (
              <Rows
                rows={[
                  ["Qualifications", qualifications.length ? <ul key="q" className="grid gap-1">{qualifications.map((q, i) => <li key={i}>{[q.degree, q.subject, q.institution, q.year].filter(Boolean).join(", ")}</li>)}</ul> : null],
                  ["Professional", professional.length ? professional.map((q) => [q.name, q.year].filter(Boolean).join(" ")).join(" · ") : null],
                  ["Subjects", teacher.specializations.length ? teacher.specializations.join(", ") : null],
                  ["Experience before joining", `${teacher.experienceYearsBefore} year${teacher.experienceYearsBefore === 1 ? "" : "s"}`],
                  ["Registration no.", teacher.teacherRegistrationNo],
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No teacher profile yet.</p>
            )}
            {canManageEmployees(ctx) && (
              <details className="rounded-lg border p-3 open:pb-4">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">{teacher ? "Edit teacher profile" : "Add teacher profile"}</summary>
                <div className="mt-3">
                  <TeacherProfileForm
                    employeeId={e.id}
                    d={{
                      version: teacher?.version ?? null,
                      qualifications,
                      professionalQualifications: professional,
                      specializations: teacher?.specializations ?? [],
                      experienceYearsBefore: teacher?.experienceYearsBefore ?? 0,
                      teacherRegistrationNo: teacher?.teacherRegistrationNo ?? null,
                    }}
                  />
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      {docs && <DocumentsCard employeeId={e.id} docs={docs} canManage={canManageDocs} uploadCode={typeof sp.upload === "string" ? sp.upload : undefined} />}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Service history</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {history.restricted ? (
            <p className="text-sm text-muted-foreground">The service history is visible only to staff with permission to view personal details.</p>
          ) : history.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No history yet.</p>
          ) : (
            <ol className="grid gap-3">
              {history.events.map((ev) => (
                <li key={ev.id} className="grid gap-1 border-l-2 pl-3">
                  <p className="text-sm">
                    <span className="font-medium">{SERVICE_EVENT_LABEL[ev.eventType]}</span> · {formatDateOnly(ev.effectiveDate)}
                  </p>
                  <p className="text-sm text-muted-foreground">{describeChange(ev.before, ev.after, history.names)}</p>
                  {"remarks" in ev && typeof ev.remarks === "string" && <p className="text-sm break-words">“{ev.remarks}”</p>}
                  {"actedBy" in ev && ev.actedBy && typeof ev.actedBy === "object" && "displayName" in ev.actedBy && <p className="text-xs text-muted-foreground">Recorded by {String(ev.actedBy.displayName)}</p>}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {account && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Login account</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {account.linked ? (
              <>
                <Rows
                  rows={[
                    ["Account", <Link key="u" href={`/erp/users/${account.linked.id}`} className="underline-offset-4 hover:underline">{account.linked.username}</Link>],
                    ["Name on account", account.linked.displayName],
                    ["Account status", account.linked.isActive ? "Active" : "Deactivated"],
                  ]}
                />
                {account.canLink && <UnlinkAccount employeeId={e.id} username={account.linked.username} />}
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">Not linked. Staff don&apos;t need a login account; link one only if this person signs in.</p>
                {account.canLink && <LinkAccountForm employeeId={e.id} candidates={account.candidates} />}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type Names = { department: Record<string, string>; designation: Record<string, string>; manager: Record<string, string> };
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** "Science → Mathematics" style summary of one service event (ids resolved to names; enums to labels). */
function describeChange(before: unknown, after: unknown, names: Names): string {
  const b = asRecord(before);
  const a = asRecord(after);
  const show = (key: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return key === "reportsToId" ? "nobody" : "—";
    const s = String(v);
    if (key === "departmentId") return names.department[s] ?? "a department";
    if (key === "designationId") return names.designation[s] ?? "a designation";
    if (key === "reportsToId") return names.manager[s] ?? "an employee";
    if (key === "employmentStatus") return EMPLOYMENT_STATUS_LABEL[s as EmploymentStatus] ?? s;
    if (key === "appointmentType") return APPOINTMENT_TYPE_LABEL[s as keyof typeof APPOINTMENT_TYPE_LABEL] ?? s;
    if (key === "staffType") return STAFF_TYPE_LABEL[s as keyof typeof STAFF_TYPE_LABEL] ?? s;
    return s;
  };
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => k !== "leavingDate");
  const parts = keys.map((k) => (k in b ? `${show(k, b[k])} → ${show(k, a[k])}` : show(k, a[k])));
  return parts.join(" · ");
}
