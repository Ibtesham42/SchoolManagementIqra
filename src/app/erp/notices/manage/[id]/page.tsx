import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Ban, Paperclip, Pencil, Send, Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDate, formatDateTime } from "@/lib/format";
import { isUploadCode, NOTICE_UPLOAD_MESSAGES } from "@/lib/http/upload-errors";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { getManagedNotice, noticeAccess } from "@/modules/notices/notices.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { deleteNoticeAction, publishNoticeAction, removeNoticeAttachmentAction, withdrawNoticeAction } from "../../actions";
import { AUDIENCE_LABEL, kb, SCOPE_LABEL, STATE_LABEL } from "../../labels";

export const metadata = { title: "Manage notice" };

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : "—");

/** Phase 6C-M1 — one notice for its manager: content, reach, read receipts and the life-cycle actions. */
export default async function ManageNoticePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!noticeAccess(ctx).manage) return <NotPermitted />;
  const [{ id }, sp, tz] = await Promise.all([params, searchParams, getSchoolTimezone()]);
  const n = await getManagedNotice(ctx, id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  // Fixed text for an attachment upload result (never text from the URL).
  const upload = isUploadCode(sp.upload) ? sp.upload : null;
  const draft = n.status === "DRAFT";
  const fields = { id: n.id, version: String(n.version) };
  const lastDay = n.expiresAt ? formatDate(new Date(n.expiresAt.getTime() - 1), tz) : null;
  const scheduled = n.publishesLater;

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <Link href="/erp/notices" className="inline-flex min-h-11 items-center gap-1 text-sm underline pointer-fine:min-h-9">
        <ArrowLeft className="size-4" aria-hidden="true" /> All notices
      </Link>
      {upload && (
        <Alert variant={upload === "ok" ? "default" : "destructive"}>
          <AlertDescription role={upload === "ok" ? "status" : "alert"}>{NOTICE_UPLOAD_MESSAGES[upload]}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              <h1 className="text-xl">{n.title}</h1>
            </CardTitle>
            <Badge variant={n.state === "LIVE" ? "default" : "secondary"}>{STATE_LABEL[n.state]}</Badge>
          </div>
          <CardDescription>
            {AUDIENCE_LABEL[n.audience]} · {SCOPE_LABEL[n.scope]}
            {n.targets.length ? `: ${n.targets.map((t) => t.label).join(", ")}` : ""} · {n.session.name}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="whitespace-pre-line">{n.body}</p>
          {n.attachment && (
            <a href={`/api/v1/notices/${encodeURIComponent(n.id)}/attachment`} className="inline-flex min-h-11 items-center gap-2 text-sm underline pointer-fine:min-h-9">
              <Paperclip className="size-4" aria-hidden="true" /> Attachment ({n.attachment.mimeType === "application/pdf" ? "PDF" : "image"}, {kb(n.attachment.sizeBytes)})
            </a>
          )}
          <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="text-muted-foreground">Written by</dt>
            <dd>{n.createdBy ?? "—"}</dd>
            <dt className="text-muted-foreground">{draft ? "Planned publication" : "Shown from"}</dt>
            <dd>{n.publishAt ? formatDateTime(n.publishAt, tz) : "When you press Publish"}</dd>
            <dt className="text-muted-foreground">Shown until</dt>
            <dd>{lastDay ?? "No end date"}</dd>
            {n.withdrawnAt && (
              <>
                <dt className="text-muted-foreground">Withdrawn</dt>
                <dd>{formatDateTime(n.withdrawnAt, tz)}</dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      {!draft && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Read receipts</h2>
            </CardTitle>
            <CardDescription>Counts only. An account counts once, however often it opens the notice.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
              {n.receipts.families && (
                <>
                  <dt className="text-muted-foreground">Families</dt>
                  <dd>
                    Seen by {n.receipts.familyReads} of {n.receipts.familyReach} family accounts ({pct(n.receipts.familyReads, n.receipts.familyReach)})
                    {n.receipts.studentReads > 0 ? ` · opened by ${n.receipts.studentReads} student accounts` : ""}
                  </dd>
                </>
              )}
              {n.receipts.staff && (
                <>
                  <dt className="text-muted-foreground">Staff</dt>
                  <dd>Opened by {n.receipts.staffReads} staff accounts</dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>
      )}

      {draft && !n.session.closed && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Draft</h2>
            </CardTitle>
            <CardDescription>Readers see nothing until you publish. After publishing the notice can&apos;t be edited, only withdrawn.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              <ConfirmAction
                label={scheduled ? "Schedule" : "Publish"}
                icon={<Send aria-hidden="true" />}
                title={`Publish "${n.title}"?`}
                description={scheduled && n.publishAt ? `Readers see it from ${formatDateTime(n.publishAt, tz)}.` : "Readers see it straight away. It can't be edited afterwards."}
                confirmLabel="Publish"
                action={publishNoticeAction}
                fields={fields}
              />
              <Button asChild variant="outline" className="min-h-11">
                <Link href={`/erp/notices/manage/${encodeURIComponent(n.id)}/edit`}>
                  <Pencil aria-hidden="true" /> Edit
                </Link>
              </Button>
              <ConfirmAction label="Delete draft" variant="destructive" icon={<Trash2 aria-hidden="true" />} title="Delete this draft?" description="It is removed for good." confirmLabel="Delete" action={deleteNoticeAction} fields={fields} />
            </div>
            <details className="rounded-lg border p-3 open:pb-4">
              <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium pointer-fine:min-h-9">
                <Paperclip className="size-4" aria-hidden="true" /> {n.attachment ? "Replace or remove the attachment" : "Attach a file"}
              </summary>
              <form method="post" encType="multipart/form-data" action={`/api/v1/notices/${encodeURIComponent(n.id)}/attachment`} className="mt-3 grid gap-2">
                <input type="hidden" name="version" value={String(n.version)} />
                <label htmlFor="notice-file" className="text-sm font-medium">
                  PDF, JPEG or PNG, up to 10 MB
                </label>
                <input id="notice-file" name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" className="min-h-11 rounded-lg border border-input p-2 text-sm" />
                <Button type="submit" variant="outline" className="min-h-11 justify-self-start">
                  Upload
                </Button>
              </form>
              {n.attachment && (
                <div className="mt-3">
                  <ConfirmAction label="Remove attachment" variant="destructive" icon={<Trash2 aria-hidden="true" />} title="Remove the attachment?" description="The file is removed from this draft." confirmLabel="Remove" action={removeNoticeAttachmentAction} fields={fields} />
                </div>
              )}
            </details>
          </CardContent>
        </Card>
      )}

      {n.status === "PUBLISHED" && (
        <div>
          <ConfirmAction
            label="Withdraw"
            variant="destructive"
            icon={<Ban aria-hidden="true" />}
            title="Withdraw this notice?"
            description="Readers stop seeing it at once. To correct it, write a new notice."
            confirmLabel="Withdraw"
            action={withdrawNoticeAction}
            fields={fields}
          />
        </div>
      )}
    </div>
  );
}
