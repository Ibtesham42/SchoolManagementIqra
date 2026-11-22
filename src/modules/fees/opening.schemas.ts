import { z } from "zod";
import { MONEY_RE } from "@/lib/money";
import { idField } from "@/modules/students/person.schemas";

/** Phase 5C-M3 opening balances (FC19). `.strict()`; the service re-checks everything against the database. */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, "Choose a real date.");

export const openingRefSchema = z.object({ academicSessionId: idField, classId: idField }).strict();

export const openingImportSchema = z
  .object({
    academicSessionId: idField,
    classId: idField,
    /** When the previous dues fall due (late-fee rules of the session apply after it). */
    dueOn: isoDate,
    entries: z
      .array(z.object({ studentId: idField, amount: z.string().regex(MONEY_RE).refine((v) => Number(v) > 0) }).strict())
      .min(1, "Nothing to import.")
      .max(500),
    /** Posted back from the preview: the import must be the one reviewed. */
    expectedTotal: z.string().regex(MONEY_RE),
  })
  .strict()
  .refine((v) => new Set(v.entries.map((e) => e.studentId)).size === v.entries.length, { message: "A student appears twice.", path: ["entries"] });

export type OpeningRefInput = z.infer<typeof openingRefSchema>;
export type OpeningImportInput = z.infer<typeof openingImportSchema>;
