import type { Metadata } from "next";
import { AuthCard } from "@/components/erp/auth-card";
import { ResetPasswordFlow } from "./reset-password-flow";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false }, referrer: "no-referrer" };

/**
 * The reset token arrives in the URL fragment (#token=…), which browsers never send to the
 * server — it can't appear in access logs. The client component reads it, removes it from the
 * address bar, validates it via a POST server action and posts it with the new password.
 */
export default function ResetPasswordPage() {
  return (
    <AuthCard title="Choose a new password">
      <ResetPasswordFlow />
    </AuthCard>
  );
}
