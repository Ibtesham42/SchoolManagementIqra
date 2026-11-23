"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Phase 6B-M1/M2 — the child's sections (profile, attendance, timetable, calendar, homework, report cards). Only /portal links (static guard). */
const TABS = [
  ["profile", "Profile"],
  ["attendance", "Attendance"],
  ["timetable", "Timetable"],
  ["calendar", "Calendar"],
  ["homework", "Homework"],
  ["results", "Report cards"],
] as const;

export function ChildTabs({ studentId, tabs }: { studentId: string; tabs: readonly string[] }) {
  const pathname = usePathname();
  const base = `/portal/c/${encodeURIComponent(studentId)}`;
  return (
    <nav aria-label="Child" className="-mx-4 mb-4 overflow-x-auto px-4">
      <ul className="flex min-w-max gap-1 border-b">
        {TABS.filter(([slug]) => tabs.includes(slug)).map(([slug, label]) => {
          const href = `${base}/${slug}`;
          const active = pathname === href;
          return (
            <li key={slug}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn("flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground", active && "border-primary font-medium text-foreground")}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
