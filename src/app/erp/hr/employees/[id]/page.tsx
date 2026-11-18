import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { canBrowseEmployees, canManageEmployees } from "@/modules/hr/hr.policy";
import { APPOINTMENT_TYPE_LABEL, STAFF_TYPE_LABEL } from "@/modules/hr/hr.rules";
import { getEmployee } from "@/modules/hr/employees.service";
import { staffAccountPanel } from "@/modules/hr/staff-accounts.service";
import { getTeacherProfile } from "@/modules/hr/teacher-profiles.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { StatusBadge } from "../parts";
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
  if (!canBrowseEmployees(ctx)) return <NotPermitted />;
  const { id } = await params;
  const sp = await searchParams;
  const e = await getEmployee(ctx, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const canEdit = canManageEmployees(ctx) && e.tier === "personal";
  const isTeaching = e.staffType === "TEACHING";
  const [teacher, account] = await Promise.all([isTeaching ? getTeacherProfile(ctx, e.id) : Promise.resolve(null), staffAccountPanel(ctx, e.id)]);
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
            <Button asChild variant="outline" className="w-full sm:w-fit">
              <Link href={`/erp/hr/employees/${e.id}/edit`}>
                <Pencil aria-hidden="true" /> Edit details
              </Link>
            </Button>
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
        <Link href="/erp/hr/employees" className="text-sm underline-offset-4 hover:underline">
          ← All staff
        </Link>
      </p>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Overview</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
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
