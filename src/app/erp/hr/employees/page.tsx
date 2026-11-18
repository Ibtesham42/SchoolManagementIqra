import Link from "next/link";
import { UserPlus } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { canBrowseEmployees, canManageEmployees, canReadPersonal } from "@/modules/hr/hr.policy";
import { APPOINTMENT_TYPE_LABEL, APPOINTMENT_TYPES, EMPLOYMENT_STATUS_LABEL, EMPLOYMENT_STATUSES, STAFF_TYPE_LABEL, STAFF_TYPES } from "@/modules/hr/hr.rules";
import { listEmployeesSchema } from "@/modules/hr/hr.schemas";
import { countEmployeesByStatus, listEmployees } from "@/modules/hr/employees.service";
import { listDepartments, listDesignations } from "@/modules/hr/master-data.service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/erp/form";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { HrTabs } from "../hr-tabs";
import { StatusBadge } from "./parts";

export const metadata = { title: "Staff" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : undefined);
const any = (label: string) => ({ value: "", label });

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireAuth();
  if (!canBrowseEmployees(ctx)) return <NotPermitted />;
  const sp = await searchParams;
  const parsed = listEmployeesSchema.safeParse({
    q: one(sp.q),
    staffType: one(sp.type),
    departmentId: one(sp.department),
    designationId: one(sp.designation),
    status: one(sp.status),
    appointmentType: one(sp.appointment),
    page: one(sp.page) ?? 1,
  });
  const filters = parsed.success ? parsed.data : listEmployeesSchema.parse({});
  const [{ total, rows, page, pageSize }, counts, departments, designations] = await Promise.all([
    listEmployees(ctx, filters),
    countEmployeesByStatus(ctx),
    listDepartments(ctx, { includeInactive: true }),
    listDesignations(ctx, { includeInactive: true }),
  ]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const canManage = canManageEmployees(ctx);

  const qs = (over: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const v = { q: filters.q, type: filters.staffType, department: filters.departmentId, designation: filters.designationId, status: filters.status, appointment: filters.appointmentType, ...over };
    for (const [k, val] of Object.entries(v)) if (val) u.set(k, val);
    const s = u.toString();
    return s ? `/erp/hr/employees?${s}` : "/erp/hr/employees";
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader
        title="Staff"
        description="Teaching and non-teaching staff. Each person has one record and a permanent employee ID."
        actions={
          canManage ? (
            <Button asChild className="w-full sm:w-fit">
              <Link href="/erp/hr/employees/new">
                <UserPlus aria-hidden="true" /> Register employee
              </Link>
            </Button>
          ) : undefined
        }
      />
      <HrTabs current="employees" />

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Staff by status">
        {EMPLOYMENT_STATUSES.map((s) => (
          <li key={s}>
            <Link href={qs({ status: s, page: undefined })} aria-current={filters.status === s ? "true" : undefined} className="flex min-h-11 flex-col rounded-lg border p-3 hover:bg-muted aria-[current=true]:border-primary">
              <span className="text-2xl font-semibold">{counts[s]}</span>
              <span className="text-xs text-muted-foreground">{EMPLOYMENT_STATUS_LABEL[s]}</span>
            </Link>
          </li>
        ))}
      </ul>

      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-3 lg:items-end">
        <div className="sm:col-span-2 lg:col-span-3">
          <TextField label="Search" name="q" defaultValue={filters.q ?? ""} placeholder={canReadPersonal(ctx) ? "Name, employee ID or phone" : "Name, employee ID or work phone"} />
        </div>
        <SelectField label="Staff type" name="type" options={[any("All"), ...STAFF_TYPES.map((t) => ({ value: t, label: STAFF_TYPE_LABEL[t] }))]} defaultValue={filters.staffType ?? ""} />
        <SelectField label="Department" name="department" options={[any("All departments"), ...departments.map((d) => ({ value: d.id, label: d.isActive ? d.name : `${d.name} (inactive)` }))]} defaultValue={filters.departmentId ?? ""} />
        <SelectField label="Designation" name="designation" options={[any("All designations"), ...designations.map((d) => ({ value: d.id, label: d.isActive ? d.name : `${d.name} (inactive)` }))]} defaultValue={filters.designationId ?? ""} />
        <SelectField label="Status" name="status" options={[any("All statuses"), ...EMPLOYMENT_STATUSES.map((s) => ({ value: s, label: EMPLOYMENT_STATUS_LABEL[s] }))]} defaultValue={filters.status ?? ""} />
        {canReadPersonal(ctx) && <SelectField label="Appointment" name="appointment" options={[any("All appointment types"), ...APPOINTMENT_TYPES.map((a) => ({ value: a, label: APPOINTMENT_TYPE_LABEL[a] }))]} defaultValue={filters.appointmentType ?? ""} />}
        <div className="flex gap-2">
          <Button type="submit" className="flex-1">Apply</Button>
          <Button asChild variant="outline" className="flex-1">
            <Link href="/erp/hr/employees">Clear</Link>
          </Button>
        </div>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{total === 0 ? "No staff found" : `${total} ${total === 1 ? "person" : "people"}`}</h2>
          </CardTitle>
          {total === 0 && <CardDescription>{canManage ? "Register an employee, or change the filters." : "Change the filters to see more staff."}</CardDescription>}
        </CardHeader>
        {rows.length > 0 && (
          <CardContent>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Employee ID</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Designation</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Department</th>
                  <th scope="col" className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="py-3 pr-3">
                      <Link href={`/erp/hr/employees/${e.id}`} className="font-medium underline-offset-4 hover:underline">
                        {e.fullName}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{STAFF_TYPE_LABEL[e.staffType]}</span>
                    </td>
                    <td className="py-3 pr-3 font-mono">{e.employeeCode}</td>
                    <td className="py-3 pr-3">{e.designation.name}</td>
                    <td className="py-3 pr-3">{e.department.name}</td>
                    <td className="py-3"><StatusBadge status={e.employmentStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="grid gap-3 md:hidden">
              {rows.map((e) => (
                <li key={e.id}>
                  <Link href={`/erp/hr/employees/${e.id}`} className="grid min-h-11 gap-1 rounded-lg border p-3 hover:bg-muted">
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-medium">{e.fullName}</span>
                      <StatusBadge status={e.employmentStatus} />
                    </span>
                    <span className="font-mono text-sm">{e.employeeCode}</span>
                    <span className="text-sm text-muted-foreground">
                      {e.designation.name} · {e.department.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-2">
          {page > 1 ? (
            <Button asChild variant="outline">
              <Link href={qs({ page: String(page - 1) })}>Previous</Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Button asChild variant="outline">
              <Link href={qs({ page: String(page + 1) })}>Next</Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
