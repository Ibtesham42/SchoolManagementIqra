import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Not found" };

/** The portal's 404 — the same page for "missing" and "not yours" (no existence oracle). */
export default function PortalNotFound() {
  return (
    <div className="py-10 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="mt-1 text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">This page doesn&apos;t exist or isn&apos;t available to your account.</p>
      <Button asChild className="mt-6">
        <Link href="/portal">Go to portal home</Link>
      </Button>
    </div>
  );
}
