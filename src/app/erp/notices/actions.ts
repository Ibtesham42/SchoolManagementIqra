"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import { createNoticeSchema, noticeRefSchema, updateNoticeSchema } from "@/modules/notices/notices.schemas";
import { createNotice, deleteNotice, publishNotice, removeNoticeAttachment, updateNotice, withdrawNotice } from "@/modules/notices/notices.service";

/** Phase 6C-M1 notices: requireAuth → Zod → service → refresh. Navigation (redirect) happens outside the try. */
const refresh = () => revalidatePath("/erp/notices", "layout");

async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, data: z.infer<S>) => Promise<string>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const message = await call(ctx, parsed.data);
    refresh();
    return { ok: true, message };
  } catch (e) {
    return fromError(e);
  }
}

const ref = (fd: FormData) => ({ id: formString(fd, "id"), version: formString(fd, "version") });
const fields = (fd: FormData) => ({
  title: formString(fd, "title"),
  body: formString(fd, "body"),
  audience: formString(fd, "audience"),
  scope: formString(fd, "scope"),
  targetIds: fd.getAll("targetIds").filter((v): v is string => typeof v === "string" && v !== ""),
  publishAt: formString(fd, "publishAt"),
  showUntil: formString(fd, "showUntil"),
});

export async function createNoticeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = createNoticeSchema.safeParse({ academicSessionId: formString(fd, "academicSessionId"), ...fields(fd) });
  if (!parsed.success) return fromZod(parsed.error);
  let id: string;
  try {
    id = (await createNotice(ctx, parsed.data)).id;
  } catch (e) {
    return fromError(e);
  }
  refresh();
  redirect(`/erp/notices/manage/${encodeURIComponent(id)}`);
}

export async function updateNoticeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = updateNoticeSchema.safeParse({ ...ref(fd), ...fields(fd) });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await updateNotice(ctx, parsed.data);
  } catch (e) {
    return fromError(e);
  }
  refresh();
  redirect(`/erp/notices/manage/${encodeURIComponent(parsed.data.id)}`);
}

export async function deleteNoticeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = noticeRefSchema.safeParse(ref(fd));
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await deleteNotice(ctx, parsed.data);
  } catch (e) {
    return fromError(e);
  }
  refresh();
  redirect("/erp/notices");
}

export async function publishNoticeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(noticeRefSchema, ref(fd), async (ctx, d) => ((await publishNotice(ctx, d)).scheduled ? "Notice scheduled. Readers see it from the chosen time." : "Notice published."));
}

export async function withdrawNoticeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(noticeRefSchema, ref(fd), async (ctx, d) => (await withdrawNotice(ctx, d), "Notice withdrawn. Readers no longer see it."));
}

export async function removeNoticeAttachmentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(noticeRefSchema, ref(fd), async (ctx, d) => (await removeNoticeAttachment(ctx, d), "Attachment removed."));
}
