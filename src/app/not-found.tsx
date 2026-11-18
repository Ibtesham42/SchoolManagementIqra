import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Page not found" };

/** Global 404 (also used by notFound() in ERP pages). */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="mt-1 text-2xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">The page you were looking for doesn&apos;t exist or has moved.</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/">Go to homepage</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/login">Portal sign in</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
