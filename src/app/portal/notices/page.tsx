import Link from "next/link";
import { ChevronRight, Paperclip } from "lucide-react";
import { requirePortal } from "@/lib/auth/context";
import { formatDateTime } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { listPortalNotices } from "@/modules/notices/notices.portal";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "Notices" };

const REACH = { SCHOOL: "Whole school", CLASS: "Your child's class", SECTION: "Your child's section" } as const;

/** Phase 6C-M1 (P22) — the school's notices for this family (all children's classes and sections), newest first. */
export default async function PortalNoticesPage() {
  const ctx = await requirePortal();
  const [items, tz] = await Promise.all([listPortalNotices(ctx), getSchoolTimezone()]);
  const student = ctx.portal.kind === "STUDENT";
  return (
    <div className="grid gap-4">
      <PageHeader title="Notices" description="Messages from the school. New ones are marked." />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notices right now.</p>
      ) : (
        <ul className="grid gap-2">
          {items.map((n) => (
            <li key={n.id}>
              <Card className="py-0">
                <CardContent className="p-0">
                  {/* prefetch off: opening a notice records that it was seen. */}
                  <Link prefetch={false} href={`/portal/notices/${encodeURIComponent(n.id)}`} className="flex min-h-16 items-center justify-between gap-3 rounded-xl px-4 py-3 hover:bg-muted">
                    <span className="grid min-w-0 gap-1">
                      <span className={n.read ? "truncate" : "truncate font-semibold"}>
                        {n.title}
                        {n.hasAttachment && <Paperclip className="ml-1 inline size-4" aria-label="Has an attachment" />}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {formatDateTime(n.publishAt, tz)} · {student && n.scope !== "SCHOOL" ? (n.scope === "CLASS" ? "Your class" : "Your section") : REACH[n.scope]}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {!n.read && <Badge>New</Badge>}
                      <ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" />
                    </span>
                  </Link>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
