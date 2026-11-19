import Link from "next/link";

/** Sub-navigation of the timetable area (server component). */
export function TimetableNav({ current, showPeriods }: { current: "section" | "periods"; showPeriods: boolean }) {
  if (!showPeriods) return null;
  const tabs = [
    { key: "section", href: "/erp/academic/timetable", label: "Section timetable" },
    { key: "periods", href: "/erp/academic/timetable/periods", label: "Periods (bell schedule)" },
  ];
  return (
    <nav aria-label="Timetable" className="flex flex-wrap gap-2">
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

export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
