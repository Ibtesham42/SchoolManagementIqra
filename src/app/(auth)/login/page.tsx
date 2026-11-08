import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { getSchoolName } from "@/modules/settings/settings.public";
import { RESET_COMPLETED_MESSAGE } from "@/modules/identity/messages";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AuthCard } from "@/components/erp/auth-card";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  // If the session check itself fails (database unreachable), still show the form;
  // the login action reports a generic error instead of the whole page failing.
  const signedIn = await getAuthContext().catch(() => null);
  if (signedIn) redirect("/erp");
  const { reset } = await searchParams;
  return (
    <AuthCard eyebrow={await getSchoolName()} title="Sign in" description="Staff, parent and student portal">
      {reset === "1" && (
        <Alert role="status" className="mb-4">
          <AlertDescription>{RESET_COMPLETED_MESSAGE}</AlertDescription>
        </Alert>
      )}
      <LoginForm />
    </AuthCard>
  );
}
