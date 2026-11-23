import { requirePortal } from "@/lib/auth/context";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";
import { ChangePasswordForm } from "@/app/erp/change-password/change-password-form";

export const metadata = { title: "Change password" };

/** Phase 6A-M2 — the portal's change-password page (the action is shared with the ERP and redirects by account kind). */
export default async function PortalChangePasswordPage() {
  const ctx = await requirePortal({ allowPendingPasswordChange: true });
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
