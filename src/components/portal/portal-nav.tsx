"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { House, IdCard, KeyRound, Megaphone, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { childIdFromPath, portalNavItems, type PortalNavIcon } from "./portal-nav-items";

/**
 * Phase 6A-M2 — the portal's own navigation (ADR-045). It never imports the ERP navigation (static guard test).
 * Phones: bottom tab bar (56 px targets). ≥ lg: a row of tabs under the header.
 */
const ICONS: Record<PortalNavIcon, LucideIcon> = { home: House, profile: IdCard, notices: Megaphone, account: KeyRound };

export function PortalNav({ childIds }: { childIds: string[] }) {
  const pathname = usePathname();
  const items = portalNavItems(childIdFromPath(pathname, childIds));
  const current = items.find((i) => (i.href === "/portal" ? pathname === "/portal" : pathname.startsWith(i.href)))?.href;
  return (
    <>
      <nav aria-label="Portal" className="hidden border-b bg-background lg:block">
        <ul className="mx-auto flex max-w-3xl gap-1 px-4">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = item.href === current;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn("flex min-h-11 items-center gap-2 border-b-2 border-transparent px-3 text-sm text-muted-foreground hover:text-foreground", active && "border-primary font-medium text-foreground")}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <nav aria-label="Portal" className="fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)] lg:hidden">
        <ul className="flex">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = item.href === current;
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn("flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-center text-xs text-muted-foreground", active && "font-medium text-foreground")}
                >
                  <Icon className="size-5" aria-hidden="true" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
