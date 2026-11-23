"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { childIdFromPath } from "./portal-nav-items";

export interface SwitcherChild {
  id: string;
  fullName: string;
  /** e.g. "Class 5 · A", or "Left school". */
  detail: string;
  current: boolean;
}

/**
 * Phase 6A-M2 — switch between the account's children (only shown with two or more). Switching keeps the current
 * page kind (profile → profile); a leaver opens on the home list, where only what is still available is offered.
 */
export function ChildSwitcher({ items }: { items: SwitcherChild[] }) {
  const pathname = usePathname();
  const selected = childIdFromPath(pathname, items.map((c) => c.id));
  if (items.length < 2) return null;
  const label = items.find((c) => c.id === selected)?.fullName ?? "Choose a child";
  const rest = selected ? pathname.split("/").slice(4).join("/") || "profile" : "profile";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="min-h-11 max-w-[60vw] justify-between gap-2" aria-label={`Switch child (now: ${label})`}>
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>Your children</DropdownMenuLabel>
        {items.map((c) => (
          <DropdownMenuItem key={c.id} asChild className="min-h-11">
            <Link href={c.current ? `/portal/c/${encodeURIComponent(c.id)}/${rest}` : "/portal"} aria-current={c.id === selected ? "page" : undefined}>
              <span className="grid">
                <span className="font-medium">{c.fullName}</span>
                <span className="text-xs text-muted-foreground">{c.detail}</span>
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
