import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { admissionFormOptions } from "@/modules/admissions/admissions.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { StudentStepForm } from "../forms";
import { STEPS } from "../parts";

export const metadata = { title: "New admission" };

/** Step 1 creates the draft; the remaining steps edit it (/erp/admissions/[id]/edit?step=N). */
export default async function NewAdmissionPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "admission.create")) return <NotPermitted />;
  const { sessions, classes, currentSessionId } = await admissionFormOptions(ctx);
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title="New admission" description={`Step 1 of ${STEPS.length}: ${STEPS[0]}. The application is saved as a draft after this step.`} />
      {sessions.length === 0 || classes.length === 0 ? (
        <Alert>
          <AlertDescription>
            {sessions.length === 0 ? "No academic session is open for admissions (Planned or Active). " : ""}
            {classes.length === 0 ? "No active class exists yet. " : ""}A School Admin can set these up in Settings and Classes.
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <StudentStepForm
              defaults={{ academicSessionId: currentSessionId && sessions.some((s) => s.id === currentSessionId) ? currentSessionId : "", classId: "", firstName: "", middleName: "", lastName: "", dob: "", gender: "" }}
              sessions={sessions.map((s) => ({ value: s.id, label: `${s.name}${s.status === "PLANNED" ? " (planned)" : ""}` }))}
              classes={classes.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
