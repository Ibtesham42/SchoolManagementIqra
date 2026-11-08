import { requireAuth } from "@/lib/auth/context";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";
import { ChangePasswordForm } from "./change-password-form";

export const metadata = { title: "Change password" };

export default async function ChangePasswordPage() {
  const ctx = await requireAuth({ allowPendingPasswordChange: true });
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Change password" description="At least 10 characters. Other devices will be signed out." />
      {ctx.mustChangePassword && (
        <Alert className="mb-4">
          <AlertDescription>You must set a new password before continuing.</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
