import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { todayInTimeZone, toDateInputValue } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { STUDENT_STATUS_LABEL } from "@/modules/students/students.rules";
import { getStudent, studentTimeZone } from "@/modules/students/students.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { StatusChangeForm } from "../../forms";

export const metadata = { title: "Record leaving" };

export default async function StudentStatusPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "student.transfer") || !hasPermission(ctx, "student.read")) return <NotPermitted />;
  const { id } = await params;
  const s = await getStudent(ctx, id).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const active = s.enrollments.filter((e) => e.status === "ACTIVE");
  const earliest = active.reduce((d, e) => (e.enrolledOn > d ? e.enrolledOn : d), s.admissionDate);
  const today = todayInTimeZone(await studentTimeZone(ctx));

  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <p className="text-sm">
        <Link href={`/erp/students/${s.id}`} className="text-muted-foreground underline-offset-4 hover:underline">
          ← {s.fullName}
        </Link>
      </p>
      <PageHeader title="Record leaving" description={`${s.fullName} · ${s.studentCode}`} />
      {s.status !== "ACTIVE" ? (
        <Alert role="status">
          <AlertDescription>This student is already {STUDENT_STATUS_LABEL[s.status].toLowerCase()}. Re-admission isn&apos;t available yet.</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Transfer, withdrawal or graduation</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StatusChangeForm id={s.id} version={s.version} today={today} earliest={toDateInputValue(earliest)} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
