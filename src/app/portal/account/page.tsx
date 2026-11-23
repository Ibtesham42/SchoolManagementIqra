import Link from "next/link";
import { requirePortal } from "@/lib/auth/context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";
import { SignOutOthersForm } from "./sign-out-others-form";

export const metadata = { title: "Account" };

/** Phase 6A-M2 — the portal account page: change password, sign out other devices (shared family phones). */
export default async function PortalAccountPage() {
  const ctx = await requirePortal();
  return (
    <div className="grid gap-4">
      <PageHeader title="Account" description={`${ctx.displayName} · ${ctx.username}`} />
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Changing your password signs you out on all other devices.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/portal/change-password">Change password</Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>Signed in on a shared or lost phone? Sign out everywhere except this device.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutOthersForm />
        </CardContent>
      </Card>
    </div>
  );
}
