import type { Metadata } from "next";
import { AuthCard } from "@/components/erp/auth-card";
import { getSchoolName } from "@/modules/settings/settings.public";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Forgot password", robots: { index: false } };
// Rendered per request so the school name comes from current settings (not frozen at build time).
export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  return (
    <AuthCard eyebrow={await getSchoolName()} title="Reset your password" description="Enter your username or email address and we will email you a reset link.">
      <ForgotPasswordForm />
    </AuthCard>
  );
}
