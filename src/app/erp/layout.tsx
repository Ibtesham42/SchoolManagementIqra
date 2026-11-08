import type { ReactNode } from "react";
import { LogOut } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { logoutAction } from "@/app/(auth)/login/actions";
import { BottomNav, SidebarNav } from "@/components/erp/erp-nav";
import { Button } from "@/components/ui/button";
import { NAV_ITEMS } from "@/components/erp/nav-items";

export const metadata = { robots: { index: false } };

export default async function ErpLayout({ children }: { children: ReactNode }) {
  // Pages enforce the forced password change themselves (requireAuth); the layout only needs a session.
  const ctx = await requireAuth({ allowPendingPasswordChange: true });
  // While a password change is pending, hasPermission() is false, so only always-visible items show.
  const items = NAV_ITEMS.filter((i) => i.anyOf.length === 0 || i.anyOf.some((p) => hasPermission(ctx, p)));

  return (
    <div className="min-h-dvh bg-muted/40 lg:grid lg:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-3 focus:shadow"
      >
        Skip to main content
      </a>
      <aside className="hidden border-r bg-background lg:block">
        <SidebarNav items={items} />
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/95 px-4 py-2 backdrop-blur">
          <span className="truncate text-sm font-medium">{ctx.displayName}</span>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost">
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </form>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-6 pb-24 outline-none lg:px-8 lg:pb-8">{children}</main>
        <BottomNav items={items} />
      </div>
    </div>
  );
}
