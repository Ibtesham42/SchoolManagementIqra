import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArrowLeft, Paperclip } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDate, formatDateTime } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { noticeAccess, openStaffNotice } from "@/modules/notices/notices.service";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { kb } from "../labels";

export const metadata = { title: "Notice" };

/** Review 6C-M1 L2: only a page opened from this site (or typed / bookmarked) counts as a read. */
async function openedHere() {
  const site = (await headers()).get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

/** Phase 6C-M1 — a staff reader opens a live staff notice (records the read receipt). Anything else → 404. */
export default async function StaffNoticePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  if (!noticeAccess(ctx).read) return <NotPermitted />;
  const { id } = await params;
  const [n, tz] = await Promise.all([
    openStaffNotice(ctx, id, { recordRead: await openedHere() }).catch((e: unknown) => {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }),
    getSchoolTimezone(),
  ]);
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <Link href="/erp/notices" className="inline-flex min-h-11 items-center gap-1 text-sm underline pointer-fine:min-h-9">
        <ArrowLeft className="size-4" aria-hidden="true" /> All notices
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">{n.title}</h1>
          </CardTitle>
          <CardDescription>
            {n.publishAt ? formatDateTime(n.publishAt, tz) : ""}
            {n.expiresAt ? ` · shown until ${formatDate(new Date(n.expiresAt.getTime() - 1), tz)}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="whitespace-pre-line">{n.body}</p>
          {n.attachment && (
            <a href={`/api/v1/notices/${encodeURIComponent(n.id)}/attachment`} className="inline-flex min-h-11 items-center gap-2 text-sm underline pointer-fine:min-h-9">
              <Paperclip className="size-4" aria-hidden="true" /> Attachment ({n.attachment.mimeType === "application/pdf" ? "PDF" : "image"}, {kb(n.attachment.sizeBytes)})
            </a>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
