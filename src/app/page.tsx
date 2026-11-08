import Link from "next/link";
import { getSchoolName } from "@/modules/settings/settings.public";
import { Button } from "@/components/ui/button";

// Placeholder public homepage until the CMS-driven website lands in Phase 2.
// Renders only the configured school name — no hard-coded school content.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const name = await getSchoolName();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <h1 className="text-3xl font-bold sm:text-4xl">{name}</h1>
      <Button asChild size="lg">
        <Link href="/login">Portal sign in</Link>
      </Button>
    </main>
  );
}
