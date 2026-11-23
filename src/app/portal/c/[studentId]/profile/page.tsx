import { notFound } from "next/navigation";
import { requirePortal } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { getPortalStudentProfile } from "@/modules/students/students.portal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Profile" };

const GENDER: Record<string, string> = { MALE: "Male", FEMALE: "Female", OTHER: "Other" };
const day = (iso: string) => formatDateOnly(new Date(`${iso}T00:00:00Z`));

/** Phase 6A-M2 — a child's profile (read only). Another family's child, a missing id or a blocked link → the same 404. */
export default async function PortalProfilePage({ params }: { params: Promise<{ studentId: string }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  const p = await getPortalStudentProfile(ctx, studentId).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const rows: [string, string | null][] = [
    ["Student ID", p.studentCode],
    ["Admission no.", p.admissionNo],
    ["Class", p.className ? `${p.className}${p.sectionCode ? ` · Section ${p.sectionCode}` : ""}` : null],
    ["Roll no.", p.rollNumber !== null ? String(p.rollNumber) : null],
    ["Session", p.sessionName],
    ["Date of birth", day(p.dob)],
    ["Gender", GENDER[p.gender] ?? p.gender],
    ["Admitted on", day(p.admissionDate)],
    ...(p.yourRelation ? ([["Your relation", p.yourRelation]] as [string, string][]) : []),
  ];
  return (
    <div className="grid gap-4">
      <PageHeader title={p.fullName} description="Student profile (read only). To correct anything, please contact the school office." />
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div key={label} className="grid gap-0.5">
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="font-medium">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
