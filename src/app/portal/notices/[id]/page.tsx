import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ArrowLeft, Paperclip } from "lucide-react";
import { requirePortal } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { openPortalNotice } from "@/modules/notices/notices.portal";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Notice" };

/** Review 6C-M1 L2: only a page opened from this site (or typed / bookmarked) counts as a read. */
async function openedHere() {
  const site = (await headers()).get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

/** Phase 6C-M1 — one notice of this family's audience (records that it was seen). Anything else → 404. */
export default async function PortalNoticePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePortal();
  const { id } = await params;
  const [n, tz] = await Promise.all([
    openPortalNotice(ctx, id, undefined, { recordRead: await openedHere() }).catch((e: unknown) => {
      if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
      throw e;
    }),
    getSchoolTimezone(),
  ]);
  return (
    <div className="grid gap-4">
      <Link href="/portal/notices" className="inline-flex min-h-11 items-center gap-1 text-sm underline">
        <ArrowLeft className="size-4" aria-hidden="true" /> All notices
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">{n.title}</h1>
          </CardTitle>
          <CardDescription>{formatDateTime(n.publishAt, tz)}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="whitespace-pre-line">{n.body}</p>
          {n.hasAttachment && (
            <a href={`/api/v1/portal/notices/${encodeURIComponent(n.id)}/attachment`} className="inline-flex min-h-11 items-center gap-2 text-sm underline">
              <Paperclip className="size-4" aria-hidden="true" /> Open the attachment
            </a>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
