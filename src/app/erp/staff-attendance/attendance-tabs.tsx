import Link from "next/link";

/** Tabs for the staff-attendance area (server component). Only tabs the caller may use are passed in. */
export function AttendanceTabs({
  current,
  showMine,
  showMark,
  showRegister,
  showSummary,
}: {
  current: "mine" | "mark" | "register" | "summary";
  showMine: boolean;
  showMark: boolean;
  showRegister: boolean;
  showSummary: boolean;
}) {
  const tabs = [
    ...(showMine ? [{ key: "mine", href: "/erp/staff-attendance", label: "My attendance" }] : []),
    ...(showMark ? [{ key: "mark", href: "/erp/staff-attendance/mark", label: "Mark a day" }] : []),
    ...(showRegister ? [{ key: "register", href: "/erp/staff-attendance/register", label: "Monthly register" }] : []),
    ...(showSummary ? [{ key: "summary", href: "/erp/staff-attendance/summary", label: "Payroll summary" }] : []),
  ];
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Staff attendance" className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className="flex min-h-11 items-center rounded-lg border px-3 text-sm aria-[current=page]:border-primary aria-[current=page]:font-medium"
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
