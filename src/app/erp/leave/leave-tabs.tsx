import Link from "next/link";

/** Tabs for the leave area (server component). Only tabs the caller may use are passed in. */
export function LeaveTabs({
  current,
  showApprovals,
  showMine,
}: {
  current: "mine" | "approvals";
  showApprovals: boolean;
  showMine: boolean;
}) {
  const tabs = [
    ...(showMine
      ? [{ key: "mine", href: "/erp/leave", label: "My leave" }]
      : []),
    ...(showApprovals
      ? [{ key: "approvals", href: "/erp/leave/approvals", label: "Approvals" }]
      : []),
  ];
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Leave" className="flex flex-wrap gap-2">
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

export const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};
