import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Shown when a signed-in user opens a screen they lack permission for.
 * This is presentation only — the service layer independently enforces authorization.
 */
export function NotPermitted() {
  return (
    <Card className="mx-auto max-w-md" role="alert">
      <CardHeader>
        <ShieldAlert className="size-6 text-muted-foreground" aria-hidden="true" />
        <CardTitle>
          <h1 className="text-xl font-semibold">You don&apos;t have access to this page</h1>
        </CardTitle>
        <CardDescription>If you need it for your work, ask your school administrator to update your role.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <Link href="/erp">Go to dashboard</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
