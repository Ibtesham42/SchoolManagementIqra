import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext, homePath } from "@/lib/auth/context";
import { getSchoolName } from "@/modules/settings/settings.public";
import { AuthCard } from "@/components/erp/auth-card";
import { ActivateForm } from "./activate-form";

export const metadata: Metadata = { title: "Activate your portal account", robots: { index: false }, referrer: "no-referrer" };

/** Phase 6A-M3 (ADR-046) — a parent opens the account the school office issued (activation slip). */
export default async function ActivatePage() {
  const signedIn = await getAuthContext().catch(() => null);
  if (signedIn) redirect(homePath(signedIn));
  const schoolName = await getSchoolName();
  return (
    <AuthCard eyebrow={schoolName} title="Activate your portal account" description="Use the activation slip you received from the school office.">
      <div className="grid gap-4">
        <ActivateForm schoolName={schoolName} />
        <Link href="/login" className="inline-flex min-h-11 items-center justify-center text-sm text-primary underline-offset-4 hover:underline">
          Already activated? Sign in
        </Link>
      </div>
    </AuthCard>
  );
}
