import Link from "next/link";
import { cn } from "@/lib/utils";

/** Server-rendered sub-navigation of the payroll area. */
export function PayrollTabs({ current }: { current: "components" | "structures" }) {
  const tabs = [
    { key: "components", href: "/erp/payroll/components", label: "Salary components" },
    { key: "structures", href: "/erp/payroll/structures", label: "Salary structures" },
  ];
  return (
    <nav aria-label="Payroll" className="flex gap-1 overflow-x-auto border-b">
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
