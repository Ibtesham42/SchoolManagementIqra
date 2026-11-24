import type { ReactNode } from "react";
import Link from "next/link";
import { Bell, LogOut } from "lucide-react";
import { requirePortal } from "@/lib/auth/context";
import { logoutAction } from "@/app/(auth)/login/actions";
import { getSchoolName } from "@/modules/settings/settings.public";
import { countPortalUnread } from "@/modules/notifications/notifications.portal";
import { listPortalChildren } from "@/modules/students/students.portal";
import { ChildSwitcher } from "@/components/portal/child-switcher";
import { PortalNav } from "@/components/portal/portal-nav";
import { Button } from "@/components/ui/button";

export const metadata = { robots: { index: false } };

/**
 * Phase 6A-M2 — the parent / student portal shell (ADR-045). Staff accounts are sent to /erp by requirePortal; this
 * layout imports no ERP navigation. Pages still call requirePortal themselves (layouts don't re-run on client
 * navigation, and actions bypass them).
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePortal({ allowPendingPasswordChange: true });
  const [kids, unread] = ctx.mustChangePassword ? [[], 0] : await Promise.all([listPortalChildren(ctx), countPortalUnread(ctx)]);
  const current = kids
    .filter((k) => k.current)
    .map((k) => ({ id: k.id, fullName: k.fullName, detail: [k.className && `Class ${k.className}`, k.sectionCode].filter(Boolean).join(" · ") || k.studentCode, current: true }));
  return (
    <div className="min-h-dvh bg-muted/40">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-3 focus:shadow"
      >
        Skip to main content
      </a>
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{await getSchoolName()}</p>
            <p className="truncate text-xs text-muted-foreground">{ctx.displayName}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!ctx.mustChangePassword && (
              // 6C-M2: the unread count renders on navigation only — never polled (plan R2).
              <Link href="/portal/inbox" aria-label={unread > 0 ? `Updates, ${unread} unread` : "Updates"} className="relative inline-flex size-11 items-center justify-center rounded-lg hover:bg-muted">
                <Bell className="size-5" aria-hidden="true" />
                {unread > 0 && <span className="absolute top-1 right-1 min-w-5 rounded-full bg-primary px-1 text-center text-xs font-semibold text-primary-foreground">{unread > 99 ? "99+" : unread}</span>}
              </Link>
            )}
            <ChildSwitcher items={current} />
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" className="min-h-11">
                <LogOut aria-hidden="true" />
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      {!ctx.mustChangePassword && <PortalNav childIds={current.map((c) => c.id)} />}
      <main id="main" tabIndex={-1} className="mx-auto max-w-3xl px-4 py-6 pb-24 outline-none lg:pb-8">
        {children}
      </main>
    </div>
  );
}
