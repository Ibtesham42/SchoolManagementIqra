import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { todayInTimeZone } from "@/lib/format";
import {
  canBrowseEmployees,
  canManageEmployees,
  canReadPersonal,
} from "@/modules/hr/hr.policy";
import {
  APPOINTMENT_TYPE_LABEL,
  APPOINTMENT_TYPES,
  STAFF_TYPE_LABEL,
} from "@/modules/hr/hr.rules";
import {
  employeeTimeZone,
  listReportingCandidates,
} from "@/modules/hr/employees.service";
import {
  listDepartments,
  listDesignations,
} from "@/modules/hr/master-data.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { RegistrationForm } from "./registration-form";

export const metadata = { title: "Register employee" };

export default async function NewEmployeePage() {
  const ctx = await requireAuth();
  // Registration enters personal details, so it needs the personal tier as well as employee.manage.
  if (
    !canManageEmployees(ctx) ||
    !canBrowseEmployees(ctx) ||
    !canReadPersonal(ctx)
  )
    return <NotPermitted />;
  const [departments, designations, managers, tz] = await Promise.all([
    listDepartments(ctx),
    listDesignations(ctx),
    listReportingCandidates(ctx),
    employeeTimeZone(ctx),
  ]);

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader
        title="Register employee"
        description="Teaching or non-teaching staff. Teacher qualifications, documents and the login account are added on the profile later."
      />
      {departments.length === 0 || designations.length === 0 ? (
        <Alert role="status">
          <AlertDescription>
            Add at least one active{" "}
            {departments.length === 0 && (
              <Link href="/erp/hr/departments" className="underline">
                department
              </Link>
            )}
            {departments.length === 0 &&
              designations.length === 0 &&
              " and one active "}
            {designations.length === 0 && (
              <Link href="/erp/hr/designations" className="underline">
                designation
              </Link>
            )}{" "}
            first.
          </AlertDescription>
        </Alert>
      ) : (
        <RegistrationForm
          today={todayInTimeZone(tz)}
          departments={departments.map((d) => ({ value: d.id, label: d.name }))}
          designations={designations.map((d) => ({
            value: d.id,
            label: `${d.name} (${STAFF_TYPE_LABEL[d.staffType]})`,
          }))}
          managers={managers.map((e) => ({
            value: e.id,
            label: `${e.fullName} · ${e.employeeCode} · ${e.designation.name}`,
          }))}
          appointmentTypes={APPOINTMENT_TYPES.map((a) => ({
            value: a,
            label: APPOINTMENT_TYPE_LABEL[a],
          }))}
        />
      )}
    </div>
  );
}
