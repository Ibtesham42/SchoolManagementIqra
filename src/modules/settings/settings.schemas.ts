import { z } from "zod";
import { canonicalTimeZone, isValidTimeZone } from "@/lib/timezones";

/** Valid IANA time zones known to this runtime (e.g. "Asia/Kolkata"); legacy names accepted. */
export { isValidTimeZone };

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v));

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM.");

export const addressSchema = z
  .object({
    line1: z.string().trim().min(3, "Enter the street address.").max(150),
    line2: optionalText(150),
    city: z.string().trim().min(2, "Enter the city or town.").max(80),
    district: optionalText(80),
    state: z.string().trim().min(2, "Enter the state.").max(80),
    pinCode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a 6-digit PIN code."),
    country: z.string().trim().min(2).max(60).default("India"),
  })
  .strict();

/** Indian phone numbers: 10-digit mobile or landline with STD code, optional +91 / 0 prefix. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^(\+91|0)?[1-9]\d{9}$/, "Enter a valid phone number (10 digits, optional +91)."));

/** Locales the UI and documents support (en-IN default). */
export const LOCALES = ["en-IN", "hi-IN", "en-GB", "en-US"] as const;
/** Display formats for dates on documents and exports; the stored value is always ISO. */
export const DATE_FORMATS = ["DD/MM/YYYY", "DD-MM-YYYY", "DD MMM YYYY", "YYYY-MM-DD"] as const;

export function isValidCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf("currency").includes(code);
}

export const schoolProfileSchema = z
  .object({
    name: z.string().trim().min(3, "Enter the school name.").max(150),
    shortCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{1,9}$/, "2–10 letters/digits, starting with a letter (used in IDs, e.g. JNV)."),
    affiliationNo: optionalText(40),
    board: optionalText(60),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .transform((v) => (v === "" ? null : v))
      .pipe(z.email("Enter a valid email address.").nullable()),
    website: z
      .string()
      .trim()
      .max(200)
      .transform((v) => (v === "" ? null : v))
      .pipe(z.url({ protocol: /^https$/, message: "Use a full https:// address." }).nullable()),
    phones: z.array(phoneSchema).max(3, "Up to 3 phone numbers."),
    address: addressSchema,
    // Stored in the current IANA spelling (legacy "Asia/Calcutta" → "Asia/Kolkata"); unknown or
    // empty values are rejected — never replaced with a default.
    timezone: z
      .string()
      .trim()
      .refine(isValidTimeZone, "Choose a valid time zone.")
      .transform((tz) => canonicalTimeZone(tz) ?? tz),
    locale: z.enum(LOCALES, "Choose a supported language/region.").default("en-IN"),
    currency: z.string().trim().toUpperCase().refine(isValidCurrency, "Use a 3-letter ISO currency code, e.g. INR.").default("INR"),
    dateFormat: z.enum(DATE_FORMATS, "Choose a date format.").default("DD/MM/YYYY"),
    timings: z
      .object({ opensAt: time, closesAt: time, officeHours: optionalText(120) })
      .strict()
      .refine((t) => t.opensAt < t.closesAt, { message: "Closing time must be after opening time.", path: ["closesAt"] }),
  })
  .strict();

export type SchoolProfileInput = z.infer<typeof schoolProfileSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.");

export const academicSessionSchema = z
  .object({
    name: z.string().trim().regex(/^\d{4}-\d{2}$/, 'Use the format "2026-27".'),
    startDate: isoDate,
    endDate: isoDate,
  })
  .strict();

export type AcademicSessionInput = z.infer<typeof academicSessionSchema>;

export const updateAcademicSessionSchema = academicSessionSchema.extend({ id: z.string().min(1).max(64) }).strict();
export const sessionIdSchema = z.object({ id: z.string().min(1).max(64) }).strict();

/**
 * Phase 6A (PHASE_6_PLAN.md §5, P14, P17, P19): the portal block of `school_setting.features` (JSON, no migration).
 * Read through `readPortalSettings`: a missing or invalid block means the safe defaults (student accounts off,
 * 180-day leaver window, no UPI details).
 */
export const UPI_VPA_RE = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,63}$/i;
export const portalSettingsSchema = z
  .object({
    studentAccounts: z.boolean().default(false),
    studentMinClassLevel: z.coerce.number().int().min(1).max(12).default(9),
    leaverAccessDays: z.coerce.number().int().min(0).max(365).default(180),
    upi: z
      .object({
        payeeName: z.string().trim().min(2).max(80),
        vpa: z.string().trim().toLowerCase().regex(UPI_VPA_RE, "Enter a UPI ID like school@bank."),
      })
      .strict()
      .nullable()
      .default(null),
    privacyNoticeVersion: z.string().trim().min(1).max(20).nullable().default(null),
  })
  .strict();
export type PortalSettings = z.infer<typeof portalSettingsSchema>;

export function readPortalSettings(features: unknown): PortalSettings {
  const block = features && typeof features === "object" ? (features as Record<string, unknown>).portal : undefined;
  const parsed = portalSettingsSchema.safeParse(block ?? {});
  return parsed.success ? parsed.data : portalSettingsSchema.parse({});
}

/**
 * Phase 6C-M3 (P19): the office form for the portal block — the school's UPI payee name and UPI ID (both, or neither =
 * "Pay by UPI" off) and the leaver access window (P17). `.strict()`.
 */
export const portalPaymentSettingsSchema = z
  .object({
    payeeName: z.string().trim().max(80, "Use at most 80 characters."),
    vpa: z.string().trim().toLowerCase().max(320),
    leaverAccessDays: z.coerce.number("Enter a number of days.").int("Whole days only.").min(0, "0 or more.").max(365, "At most 365."),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.payeeName === "") !== (v.vpa === "")) ctx.addIssue({ code: "custom", path: [v.payeeName === "" ? "payeeName" : "vpa"], message: "Fill in both, or clear both to turn UPI payments off." });
    if (v.payeeName !== "" && v.payeeName.length < 2) ctx.addIssue({ code: "custom", path: ["payeeName"], message: "Use at least 2 characters." });
    // Review 6C-M3 L4: no control, zero-width or direction-override characters (a misleading payee name).
    if (/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/.test(v.payeeName)) ctx.addIssue({ code: "custom", path: ["payeeName"], message: "Remove special characters." });
    if (v.vpa !== "" && !UPI_VPA_RE.test(v.vpa)) ctx.addIssue({ code: "custom", path: ["vpa"], message: "Enter a UPI ID like school@bank." });
  });
export type PortalPaymentSettingsInput = z.infer<typeof portalPaymentSettingsSchema>;
