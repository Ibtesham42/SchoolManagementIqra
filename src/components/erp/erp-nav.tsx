"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { KeyRound, LayoutDashboard, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavIcon, NavItem } from "./nav-items";

const ICONS: Record<NavIcon, LucideIcon> = { dashboard: LayoutDashboard, users: Users, roles: ShieldCheck, account: KeyRound };

function isActive(pathname: string, href: string) {
  return href === "/erp" ? pathname === "/erp" : pathname === href || pathname.startsWith(`${href}/`);
}

/** Desktop sidebar (≥ lg). */
export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="sticky top-0 p-4">
      <p className="mb-4 px-3 text-sm font-semibold">School ERP</p>
      <ul className="space-y-1">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                  active && "bg-muted font-medium text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Mobile bottom tab bar (< lg): up to 4 role-specific shortcuts, 56px tall touch targets. */
export function BottomNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="flex">
        {items.slice(0, 4).map((item) => {
          const Icon = ICONS[item.icon];
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-center text-xs text-muted-foreground",
                  active && "font-medium text-foreground",
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
