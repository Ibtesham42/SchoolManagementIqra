import Link from "next/link";
import { Paperclip, Plus } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateTime } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { listManagedNotices, listStaffNotices, noticeAccess, noticeComposeOptions } from "@/modules/notices/notices.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AUDIENCE_LABEL, SCOPE_LABEL, STATE_LABEL } from "./labels";

export const metadata = { title: "Notices" };

/** Phase 6C-M1 (P22) — notices for staff, and the notices this user writes (notice.manage). */
export default async function NoticesPage() {
  const ctx = await requireAuth();
  const access = noticeAccess(ctx);
  if (!access.read && !access.manage) return <NotPermitted />;
  const [tz, staffNotices, compose] = await Promise.all([getSchoolTimezone(), access.read ? listStaffNotices(ctx) : Promise.resolve([]), access.manage ? noticeComposeOptions(ctx) : Promise.resolve(null)]);
  const managed = compose ? await listManagedNotices(ctx, compose.session.id) : [];

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Notices" description="School notices for staff. Notices for families appear in the parent portal." />
      {access.read && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>For staff ({staffNotices.length})</h2>
            </CardTitle>
            <CardDescription>Newest first. Unread notices are marked.</CardDescription>
          </CardHeader>
          <CardContent>
            {staffNotices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No notices for staff right now.</p>
            ) : (
              <ul className="grid gap-2">
                {staffNotices.map((n) => (
                  <li key={n.id}>
                    {/* prefetch off: opening a notice records a read receipt. */}
                    <Link prefetch={false} href={`/erp/notices/${encodeURIComponent(n.id)}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 hover:bg-muted">
                      <span className={n.read ? "" : "font-semibold"}>
                        {n.title}
                        {n.hasAttachment && <Paperclip className="ml-1 inline size-4" aria-label="Has an attachment" />}
                      </span>
                      <span className="flex items-center gap-2 text-sm text-muted-foreground">
                        {!n.read && <Badge>New</Badge>}
                        {n.publishAt ? formatDateTime(n.publishAt, tz) : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      {access.manage && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{access.manage === "ALL" ? "Notices you manage" : "Notices to your section's families"}</h2>
            </CardTitle>
            <CardDescription>{compose ? `${compose.session.name}: drafts, scheduled, published and withdrawn notices.` : "There is no open academic session."}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {compose && (access.manage === "ALL" || compose.sections.length > 0) ? (
              <Button asChild className="min-h-11 justify-self-start">
                <Link href="/erp/notices/new">
                  <Plus aria-hidden="true" /> Write a notice
                </Link>
              </Button>
            ) : compose ? (
              <Alert>
                <AlertDescription>You aren&apos;t class teacher of a section in {compose.session.name}, so you can&apos;t write notices now.</AlertDescription>
              </Alert>
            ) : null}
            {managed.length === 0 ? (
              <p className="text-sm text-muted-foreground">No notices yet.</p>
            ) : (
              <ul className="grid gap-2">
                {managed.map((n) => (
                  <li key={n.id}>
                    <Link href={`/erp/notices/manage/${encodeURIComponent(n.id)}`} className="grid min-h-11 gap-1 rounded-lg border px-3 py-2 hover:bg-muted">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{n.title}</span>
                        <Badge variant={n.state === "LIVE" ? "default" : "secondary"}>{STATE_LABEL[n.state]}</Badge>
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {AUDIENCE_LABEL[n.audience]} · {SCOPE_LABEL[n.scope]}
                        {n.scope !== "SCHOOL" ? ` (${n.targets})` : ""}
                        {n.publishAt && n.state !== "DRAFT" ? ` · ${formatDateTime(n.publishAt, tz)}` : ""}
                        {n.state !== "DRAFT" ? ` · opened ${n.reads}×` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
