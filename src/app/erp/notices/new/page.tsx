import { requireAuth } from "@/lib/auth/context";
import { noticeAccess, noticeComposeOptions } from "@/modules/notices/notices.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { NoticeForm } from "../notice-form";

export const metadata = { title: "Write a notice" };

/** Phase 6C-M1 — a new notice is saved as a draft first; publishing is a separate step on the notice's page. */
export default async function NewNoticePage() {
  const ctx = await requireAuth();
  if (!noticeAccess(ctx).manage) return <NotPermitted />;
  const o = await noticeComposeOptions(ctx);
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title="Write a notice" description={o ? `Saved as a draft in ${o.session.name}. You can attach a file and publish it next.` : undefined} />
      {!o ? (
        <Alert>
          <AlertDescription>There is no open academic session.</AlertDescription>
        </Alert>
      ) : o.scope === "ASSIGNED" && o.sections.length === 0 ? (
        <Alert>
          <AlertDescription>You aren&apos;t class teacher of a section in {o.session.name}.</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent>
            <NoticeForm
              academicSessionId={o.session.id}
              manage={o.scope}
              classes={o.classes.map((c) => ({ id: c.id, name: c.name }))}
              sections={o.sections}
              timeZone={o.timeZone}
              defaults={{ title: "", body: "", audience: "FAMILIES", scope: o.scope === "ASSIGNED" ? "SECTION" : "SCHOOL", targetIds: o.scope === "ASSIGNED" && o.sections.length === 1 ? [o.sections[0].id] : [], publishAt: "", showUntil: "" }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
