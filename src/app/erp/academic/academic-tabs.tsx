import Link from "next/link";
import { cn } from "@/lib/utils";

/** Server-rendered sub-navigation between Sections, Classes and Subjects (links, no client state). */
export function AcademicTabs({ current, showClasses, showSubjects = false }: { current: "sections" | "classes" | "subjects" | "class-subjects"; showClasses: boolean; showSubjects?: boolean }) {
  const tabs = [
    { key: "sections", href: "/erp/academic/sections", label: "Sections" },
    ...(showClasses ? [{ key: "classes", href: "/erp/academic/classes", label: "Classes" }] : []),
    ...(showSubjects ? [{ key: "subjects", href: "/erp/academic/subjects", label: "Subjects" }] : []),
    ...(showSubjects ? [{ key: "class-subjects", href: "/erp/academic/class-subjects", label: "Class subjects" }] : []),
  ];
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Classes and sections" className="flex gap-1 overflow-x-auto border-b">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={cn(
            "flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-4 text-sm text-muted-foreground hover:text-foreground pointer-fine:min-h-10",
            t.key === current && "border-primary font-medium text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
