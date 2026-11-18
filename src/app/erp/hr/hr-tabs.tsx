import Link from "next/link";
import { cn } from "@/lib/utils";

/** Server-rendered sub-navigation for the staff area (links, no client state). */
export function HrTabs({ current }: { current: "overview" | "employees" | "departments" | "designations" }) {
  const tabs = [
    { key: "overview", href: "/erp/hr", label: "Overview" },
    { key: "employees", href: "/erp/hr/employees", label: "Staff" },
    { key: "departments", href: "/erp/hr/departments", label: "Departments" },
    { key: "designations", href: "/erp/hr/designations", label: "Designations" },
  ];
  return (
    <nav aria-label="Staff" className="flex gap-1 overflow-x-auto border-b">
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
