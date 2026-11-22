import { z } from "zod";
import { idField } from "@/modules/students/person.schemas";

/**
 * Phase 5C-M1 fee reports (PHASE_5_PLAN.md FC20). One `.strict()` query shape for the page (GET filters — no
 * personal data in them) and the CSV export (POSTed form). The service checks which fields each report needs.
 */
export const REPORT_NAMES = ["collection", "outstanding", "defaulters", "concessions", "cancelled-receipts", "cancelled-invoices"] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export const REPORT_LABEL: Record<ReportName, string> = {
  collection: "Collection",
  outstanding: "Outstanding",
  defaulters: "Defaulters",
  concessions: "Concession register",
  "cancelled-receipts": "Cancelled receipts",
  "cancelled-invoices": "Cancelled invoices",
};

/** Reports over a session vs a date range. */
export const SESSION_REPORTS: readonly ReportName[] = ["outstanding", "defaulters", "concessions", "cancelled-invoices"];
export const RANGE_REPORTS: readonly ReportName[] = ["collection", "cancelled-receipts"];

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, "Choose a real date.");

/** At most a year in one report (bounded queries on the free-tier database). */
export const MAX_RANGE_DAYS = 366;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const reportQuerySchema = z
  .object({
    report: z.enum(REPORT_NAMES, "Choose a report."),
    academicSessionId: idField.optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    groupBy: z.enum(["day", "method", "collector", "category"]).default("day"),
    by: z.enum(["class", "installment"]).default("class"),
    minDays: z.coerce.number().int().min(0).max(365).default(1),
  })
  .strict()
  .refine((v) => !SESSION_REPORTS.includes(v.report) || v.academicSessionId !== undefined, { message: "Choose an academic session.", path: ["academicSessionId"] })
  .refine((v) => !RANGE_REPORTS.includes(v.report) || (v.from !== undefined && v.to !== undefined), { message: "Choose the dates.", path: ["from"] })
  .refine((v) => v.from === undefined || v.to === undefined || (days(v.from, v.to) >= 0 && days(v.from, v.to) < MAX_RANGE_DAYS), { message: `The end date must be on or after the start date, and at most ${MAX_RANGE_DAYS} days later.`, path: ["to"] });

export type ReportQuery = z.infer<typeof reportQuerySchema>;
