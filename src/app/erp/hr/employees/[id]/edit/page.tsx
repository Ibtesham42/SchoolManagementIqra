import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { toDateInputValue, todayInTimeZone } from "@/lib/format";
import { canBrowseEmployees, canManageEmployees, canReadPersonal } from "@/modules/hr/hr.policy";
import { employeeTimeZone, getEmployee } from "@/modules/hr/employees.service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { ContactForm, PersonalForm } from "./edit-forms";

export const metadata = { title: "Edit employee" };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export default async function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!canManageEmployees(ctx) || !canBrowseEmployees(ctx) || !canReadPersonal(ctx)) return <NotPermitted />;
  const { id } = await params;
  const [e, tz] = await Promise.all([
    getEmployee(ctx, id).catch((err) => {
      if (err instanceof NotFoundError) notFound();
      throw err;
    }),
    employeeTimeZone(ctx),
  ]);
  if (e.tier !== "personal") return <NotPermitted />;
  const a = obj(e.address);
  const ec = obj(e.emergencyContact);

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title={`Edit ${e.fullName}`} description={`${e.employeeCode} — the employee ID never changes.`} />
      <p>
        <Link href={`/erp/hr/employees/${e.id}`} className="text-sm underline-offset-4 hover:underline">
          ← Back to the profile
        </Link>
      </p>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Personal details</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PersonalForm
            id={e.id}
            version={e.version}
            today={todayInTimeZone(tz)}
            d={{ firstName: e.firstName, middleName: e.middleName ?? "", lastName: e.lastName ?? "", dob: toDateInputValue(e.dob), gender: e.gender }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Contact details</h2>
          </CardTitle>
          <CardDescription>Saving one section reloads the other with the latest version.</CardDescription>
        </CardHeader>
        <CardContent>
          <ContactForm
            id={e.id}
            version={e.version}
            d={{
              personalPhone: e.personalPhone,
              workPhone: e.workPhone ?? "",
              personalEmail: e.personalEmail ?? "",
              workEmail: e.workEmail ?? "",
              line1: str(a.line1),
              line2: str(a.line2),
              city: str(a.city),
              district: str(a.district),
              state: str(a.state),
              pinCode: str(a.pinCode),
              country: str(a.country) || "India",
              ecName: str(ec.name),
              ecRelation: str(ec.relation),
              ecPhone: str(ec.phone),
            }}
          />
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">Department, designation, appointment type, reporting line and status changes are recorded in the service history and arrive in a later release.</p>
    </div>
  );
}
