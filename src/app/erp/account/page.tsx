import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { ROLES } from "@/lib/rbac/catalog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";
import { SignOutOthersForm } from "./sign-out-others-form";

export const metadata = { title: "My account" };

export default async function AccountPage() {
  const ctx = await requireAuth();
  const roles = ctx.roleKeys.map((k) => ROLES.find((r) => r.key === k)?.name ?? k);
  return (
    <div className="mx-auto grid max-w-2xl gap-4">
      <PageHeader title="My account" description={`${ctx.displayName} · ${ctx.username}`} />
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>{roles.join(", ") || "No role assigned — contact your administrator."}</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Changing your password signs you out on all other devices.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href="/erp/change-password">Change password</Link>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>Lost a phone or used a shared computer? Sign out everywhere except this device.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutOthersForm />
        </CardContent>
      </Card>
    </div>
  );
}
