import { z } from "zod";
import { idField, isoDateSchema, versionField } from "@/modules/students/person.schemas";

/**
 * Phase 6C-M1 notices (P22): plain text ≤ 4,000 characters, one audience and scope, targets for CLASS / SECTION.
 * `.strict()`. The service re-checks every rule under its locks (who may write where, the session, the targets).
 */
const CONTROL_LINE = /[\u0000-\u001F\u007F​﻿]/;
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/; // keeps \t \n \r

export const MAX_NOTICE_TARGETS = 50;

const title = z
  .string()
  .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Give the notice a title.").max(150, "Use at most 150 characters."))
  .refine((v) => !CONTROL_LINE.test(v), "Remove control characters.");

const body = z
  .string()
  .transform((v) => v.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim())
  .pipe(z.string().min(1, "Write the notice.").max(4000, "Use at most 4000 characters."))
  .refine((v) => !CONTROL_TEXT.test(v), "Remove control characters.");

/** Empty = "publish when I press Publish"; otherwise a school-local `datetime-local` value. */
const publishAt = z
  .string()
  .trim()
  .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v), "Use a valid date and time.");
/** Empty = no expiry; otherwise the last school-local day it is shown. */
const showUntil = z.union([z.literal(""), isoDateSchema]);

/** FAMILIES = parents and student accounts; PARENTS = parent accounts only (6C-M4). */
export const NOTICE_AUDIENCES = ["FAMILIES", "PARENTS", "STAFF", "ALL"] as const;
export const NOTICE_SCOPES = ["SCHOOL", "CLASS", "SECTION"] as const;

const fields = {
  title,
  body,
  audience: z.enum(NOTICE_AUDIENCES, "Choose who the notice is for."),
  scope: z.enum(NOTICE_SCOPES, "Choose how far the notice reaches."),
  targetIds: z.array(idField).max(MAX_NOTICE_TARGETS, `Choose at most ${MAX_NOTICE_TARGETS}.`),
  publishAt,
  showUntil,
};

type Shape = { audience: (typeof NOTICE_AUDIENCES)[number]; scope: (typeof NOTICE_SCOPES)[number]; targetIds: string[] };
/** The combinations the database CHECKs allow, as field errors (staff notices are school-wide only). */
function combination(v: Shape, ctx: z.RefinementCtx) {
  if ((v.audience === "STAFF" || v.audience === "ALL") && v.scope !== "SCHOOL") ctx.addIssue({ code: "custom", path: ["scope"], message: "Notices for staff go to the whole school." });
  if (v.scope === "SCHOOL" && v.targetIds.length > 0) ctx.addIssue({ code: "custom", path: ["targetIds"], message: "A whole-school notice has no classes or sections." });
  if (v.scope !== "SCHOOL" && v.targetIds.length === 0) ctx.addIssue({ code: "custom", path: ["targetIds"], message: v.scope === "CLASS" ? "Choose at least one class." : "Choose at least one section." });
  if (new Set(v.targetIds).size !== v.targetIds.length) ctx.addIssue({ code: "custom", path: ["targetIds"], message: "Each class or section once." });
}

export const createNoticeSchema = z
  .object({ academicSessionId: idField, ...fields })
  .strict()
  .superRefine(combination);
export const updateNoticeSchema = z
  .object({ id: idField, version: versionField, ...fields })
  .strict()
  .superRefine(combination);
export const noticeRefSchema = z.object({ id: idField, version: versionField }).strict();
export const noticeIdSchema = z.object({ id: idField }).strict();

export type CreateNoticeInput = z.infer<typeof createNoticeSchema>;
export type UpdateNoticeInput = z.infer<typeof updateNoticeSchema>;
export type NoticeRefInput = z.infer<typeof noticeRefSchema>;
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];
export type NoticeScope = (typeof NOTICE_SCOPES)[number];
