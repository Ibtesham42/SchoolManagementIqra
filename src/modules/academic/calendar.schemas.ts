import { z } from "zod";
import { idField, isoDateSchema, versionField } from "@/modules/students/person.schemas";

/** Phase 4C-M3 academic calendar (AC18). `.strict()`. */
const CONTROL_LINE = /[\u0000-\u001F\u007F​﻿]/;
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/;

const title = z
  .string()
  .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Give the event a title.").max(120, "Use at most 120 characters."))
  .refine((v) => !CONTROL_LINE.test(v), "Remove control characters.");
const details = z
  .string()
  .transform((v) => v.normalize("NFC").replace(/\r\n?/g, "\n").trim())
  .pipe(z.string().max(1000, "Use at most 1000 characters."))
  .refine((v) => !CONTROL_TEXT.test(v), "Remove control characters.")
  .transform((v) => (v === "" ? null : v));
const optionalEnd = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(isoDateSchema.nullable());

const ORDER = { message: "The end date is before the start date.", path: ["endDate"] };
const inOrder = (v: { startDate: string; endDate: string | null }) => v.endDate === null || v.endDate >= v.startDate;

export const createEventSchema = z.object({ academicSessionId: idField, title, startDate: isoDateSchema, endDate: optionalEnd, details }).strict().refine(inOrder, ORDER);
export const updateEventSchema = z.object({ id: idField, version: versionField, title, startDate: isoDateSchema, endDate: optionalEnd, details }).strict().refine(inOrder, ORDER);
export const eventRefSchema = z.object({ id: idField, version: versionField }).strict();
export const calendarMonthSchema = z
  .object({ academicSessionId: idField, month: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-11.") })
  .strict();

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type EventRefInput = z.infer<typeof eventRefSchema>;
export type CalendarMonthInput = z.infer<typeof calendarMonthSchema>;
