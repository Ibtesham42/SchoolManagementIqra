import Link from "next/link";
import { cn } from "@/lib/utils";

/** Server-rendered sub-navigation of the fees area (Phase 5A-M2: setup screens). */
export function FeesTabs({ current, session }: { current: "heads" | "schedule" | "structures" | "concessions" | "charges" | "invoices" | "collect" | "receipts" | "reports" | "opening"; session?: string }) {
  const q = session ? `?session=${encodeURIComponent(session)}` : "";
  const tabs = [
    { key: "collect", href: "/erp/fees/collect", label: "Collect" },
    { key: "receipts", href: "/erp/fees/receipts", label: "Receipts" },
    { key: "heads", href: "/erp/fees", label: "Fee heads" },
    { key: "schedule", href: `/erp/fees/schedule${q}`, label: "Installments & late fee" },
    { key: "structures", href: `/erp/fees/structures${q}`, label: "Class fees" },
    { key: "concessions", href: `/erp/fees/concessions${q}`, label: "Concessions" },
    { key: "charges", href: `/erp/fees/charges${q}`, label: "Extra charges" },
    { key: "invoices", href: `/erp/fees/invoices${q}`, label: "Invoices" },
    { key: "opening", href: `/erp/fees/opening-balances${q}`, label: "Previous dues" },
    { key: "reports", href: "/erp/fees/reports", label: "Reports" },
  ];
  return (
    <nav aria-label="Fees" className="flex gap-1 overflow-x-auto border-b">
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

/** GET form to choose the academic session (no client state). */
export function SessionPicker({ sessions, current, action }: { sessions: { id: string; name: string; status: string }[]; current: string; action: string }) {
  if (sessions.length <= 1) return null;
  return (
    <form method="get" action={action} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <label className="grid gap-1.5 text-sm font-medium" htmlFor="fee-session">
        Academic session
        <select id="fee-session" name="session" defaultValue={current} className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm">
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.status.toLowerCase()})
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="min-h-11 rounded-lg border px-4 text-sm font-medium hover:bg-muted">
        Show
      </button>
    </form>
  );
}

/** The session to show: ?session=, else the current one, else the newest. */
export function pickSession<T extends { id: string; isCurrent: boolean }>(sessions: T[], wanted: string | string[] | undefined): T | undefined {
  return sessions.find((s) => s.id === wanted) ?? sessions.find((s) => s.isCurrent) ?? sessions[0];
}
