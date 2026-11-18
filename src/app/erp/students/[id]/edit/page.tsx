import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { toDateInputValue } from "@/lib/format";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { getStudent } from "@/modules/students/students.service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { RELATION_LABEL, type Address } from "../../../admissions/parts";
import { GuardianEditForm, StudentEditForm } from "../../forms";

export const metadata = { title: "Edit student" };

/**
 * Field-level edit (design §4.2): ALL scope edits identity + contact fields; a class teacher (ASSIGNED)
 * sees only contact fields. The service enforces the same rule on the server.
 */
export default async function EditStudentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  const scope = hasPermission(ctx, "student.update") ? scopeFor(ctx, "student.update") : null;
  if ((scope !== "ALL" && scope !== "ASSIGNED") || !hasPermission(ctx, "student.read")) return <NotPermitted />;
  const { id } = await params;
  const s = await getStudent(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const identity = scope === "ALL";
  const a = (s.address ?? {}) as NonNullable<Address>;

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <p className="text-sm">
        <Link href={`/erp/students/${s.id}`} className="text-muted-foreground underline-offset-4 hover:underline">
          ← {s.fullName}
        </Link>
      </p>
      <PageHeader title="Edit student" description={`${s.studentCode} · Admission no. ${s.admissionNo}${identity ? "" : " · You can change contact details for students of your section."}`} />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Student details</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <StudentEditForm
            identity={identity}
            d={{
              id: s.id,
              version: s.version,
              firstName: s.firstName,
              middleName: s.middleName ?? "",
              lastName: s.lastName ?? "",
              dob: toDateInputValue(s.dob),
              gender: s.gender,
              phone: s.phone ?? "",
              email: s.email ?? "",
              line1: a.line1 ?? "",
              line2: a.line2 ?? "",
              city: a.city ?? "",
              district: a.district ?? "",
              state: a.state ?? "",
              pinCode: a.pinCode ?? "",
              country: a.country ?? "India",
            }}
          />
        </CardContent>
      </Card>
      {s.guardians.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Parents / guardians</h2>
            </CardTitle>
            <CardDescription>Each guardian is saved separately. Linking or removing guardians isn&apos;t available here.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {s.guardians.map((g) => (
              <GuardianEditForm
                key={g.guardian.id}
                identity={identity}
                d={{
                  studentId: s.id,
                  guardianId: g.guardian.id,
                  relationLabel: RELATION_LABEL[g.relation],
                  name: g.guardian.name,
                  occupation: g.guardian.occupation ?? "",
                  phone: g.guardian.phone,
                  altPhone: g.guardian.altPhone ?? "",
                  email: g.guardian.email ?? "",
                  sharedWith: g.guardian._count.students - 1,
                }}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
