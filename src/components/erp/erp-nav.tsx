"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ClipboardList, GraduationCap, IdCard, KeyRound, ListOrdered, LayoutDashboard, Menu, Settings, ShieldCheck, UserRoundCog, Users, type LucideIcon } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { activeNavHref, type NavIcon, type NavItem } from "./nav-items";

const ICONS: Record<NavIcon, LucideIcon> = { dashboard: LayoutDashboard, admissions: ClipboardList, students: IdCard, rollNumbers: ListOrdered, academic: GraduationCap, users: Users, roles: ShieldCheck, settings: Settings, account: KeyRound, staff: UserRoundCog };


/** Desktop sidebar (≥ lg). */
export function SidebarNav({ items }: { items: NavItem[] }) {
  const current = activeNavHref(usePathname(), items);
  return (
    <nav aria-label="Main" className="sticky top-0 p-4">
      <p className="mb-4 px-3 text-sm font-semibold">School ERP</p>
      <ul className="space-y-1">
        {items.map((item) => {
          const Icon = ICONS[item.icon];
          const active = item.href === current;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground pointer-fine:min-h-10",
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

/** Mobile bottom tab bar (< lg): up to 4 shortcuts; with more items, 3 shortcuts + "More" (sheet). 56px touch targets. */
export function BottomNav({ items }: { items: NavItem[] }) {
  const current = activeNavHref(usePathname(), items);
  const [open, setOpen] = useState(false);
  const overflow = items.length > 4;
  const primary = overflow ? items.slice(0, 3) : items;
  const rest = overflow ? items.slice(3) : [];
  const restActive = rest.some((i) => i.href === current);
  const tab = "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-center text-xs text-muted-foreground";
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="flex">
        {primary.map((item) => {
          const Icon = ICONS[item.icon];
          const active = item.href === current;
          return (
            <li key={item.href} className="flex-1">
              <Link href={item.href} aria-current={active ? "page" : undefined} className={cn(tab, active && "font-medium text-foreground")}>
                <Icon className="size-5" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
        {overflow && (
          <li className="flex-1">
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger className={cn(tab, restActive && "font-medium text-foreground")}>
                <Menu className="size-5" aria-hidden="true" />
                More
              </SheetTrigger>
              <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
                <SheetHeader>
                  <SheetTitle>More</SheetTitle>
                  <SheetDescription className="sr-only">Other sections</SheetDescription>
                </SheetHeader>
                <ul className="grid gap-1 px-4 pb-4">
                  {rest.map((item) => {
                    const Icon = ICONS[item.icon];
                    const active = item.href === current;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setOpen(false)}
                          aria-current={active ? "page" : undefined}
                          className={cn("flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm hover:bg-muted", active && "bg-muted font-medium")}
                        >
                          <Icon className="size-5" aria-hidden="true" />
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </SheetContent>
            </Sheet>
          </li>
        )}
      </ul>
    </nav>
  );
}
