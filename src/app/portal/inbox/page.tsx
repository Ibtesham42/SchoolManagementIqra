import { requirePortal } from "@/lib/auth/context";
import { formatDateTime } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { listPortalNotifications } from "@/modules/notifications/notifications.portal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";
import { markAllReadAction, openNotificationAction } from "./actions";

export const metadata = { title: "Updates" };

/** Phase 6C-M2 (P23) — this account's in-app notifications, newest first (kept 90 days). */
export default async function PortalInboxPage() {
  const ctx = await requirePortal();
  const [items, tz] = await Promise.all([listPortalNotifications(ctx), getSchoolTimezone()]);
  const unread = items.some((n) => !n.readAt);
  return (
    <div className="grid gap-4">
      <PageHeader title="Updates" description="Report cards, absences, receipts and notices from the school. Kept for 90 days." />
      {unread && (
        <form action={markAllReadAction}>
          <Button type="submit" variant="outline" className="min-h-11">
            Mark all as read
          </Button>
        </form>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No updates yet.</p>
      ) : (
        <ul className="grid gap-2">
          {items.map((n) => (
            <li key={n.id}>
              <Card className="py-0">
                <CardContent className="p-0">
                  <form action={openNotificationAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <button type="submit" className="grid min-h-16 w-full gap-1 rounded-xl px-4 py-3 text-left hover:bg-muted">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className={n.readAt ? "" : "font-semibold"}>{n.title}</span>
                        {!n.readAt && <Badge>New</Badge>}
                      </span>
                      <span className="text-sm">{n.body}</span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(n.createdAt, tz)}</span>
                    </button>
                  </form>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
