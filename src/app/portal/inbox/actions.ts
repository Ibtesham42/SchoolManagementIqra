"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePortal } from "@/lib/auth/context";
import { formString } from "@/lib/action-state";
import { NotFoundError } from "@/lib/errors";
import { openPortalNotification } from "@/modules/notifications/notifications.portal";
import { markAllMyNotificationsRead } from "@/modules/notifications/notifications.service";

/**
 * Phase 6C-M2 — opening a notification is a POST (never a GET side effect): mark it read, then go to its page. The
 * service returns only a `/portal/` path; an id that isn't this account's lands back on the inbox.
 */
export async function openNotificationAction(fd: FormData): Promise<void> {
  const ctx = await requirePortal();
  const id = formString(fd, "id");
  let to = "/portal/inbox";
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    try {
      to = await openPortalNotification(ctx, id);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
  }
  revalidatePath("/portal", "layout");
  redirect(to);
}

export async function markAllReadAction(): Promise<void> {
  const ctx = await requirePortal();
  await markAllMyNotificationsRead(ctx);
  revalidatePath("/portal", "layout");
}
