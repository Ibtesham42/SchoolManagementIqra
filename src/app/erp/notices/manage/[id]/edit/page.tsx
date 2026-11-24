import { notFound, redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { utcToLocalDateTime } from "@/lib/zoned-time";
import { getManagedNotice, noticeAccess, noticeComposeOptions } from "@/modules/notices/notices.service";
import { Card, CardContent } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { NoticeForm } from "../../../notice-form";

export const metadata = { title: "Edit notice" };

/** Phase 6C-M1 — drafts only (published notices are withdrawn, never edited — P22). */
export default async function EditNoticePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!noticeAccess(ctx).manage) return <NotPermitted />;
  const { id } = await params;
  const [n, o] = await Promise.all([
    getManagedNotice(ctx, id).catch((e: unknown) => {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }),
    noticeComposeOptions(ctx),
  ]);
  if (n.status !== "DRAFT" || n.session.closed || !o) redirect(`/erp/notices/manage/${encodeURIComponent(n.id)}`);
  // A draft of another (still open) session keeps only its own targets as choices.
  const sameSession = o.session.id === n.session.id;
  const tz = o.timeZone;
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title="Edit notice" description="Changes stay in the draft until you publish." />
      <Card>
        <CardContent>
          <NoticeForm
            manage={o.scope}
            classes={sameSession ? o.classes.map((c) => ({ id: c.id, name: c.name })) : n.scope === "CLASS" ? n.targets.map((t) => ({ id: t.id, name: t.label })) : []}
            sections={sameSession ? o.sections : n.scope === "SECTION" ? n.targets.map((t) => ({ id: t.id, code: t.label })) : []}
            timeZone={tz}
            defaults={{
              id: n.id,
              version: n.version,
              title: n.title,
              body: n.body,
              audience: n.audience,
              scope: n.scope,
              targetIds: n.targets.map((t) => t.id),
              publishAt: n.publishAt ? utcToLocalDateTime(n.publishAt, tz) : "",
              showUntil: n.expiresAt ? todayInTimeZone(tz, new Date(n.expiresAt.getTime() - 1)) : "",
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
