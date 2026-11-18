import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalTimeZone, isValidTimeZone, LEGACY_TIME_ZONE_ALIASES, selectedTimeZone, timeZoneOptions } from "@/lib/timezones";
import { schoolProfileSchema } from "@/modules/settings/settings.schemas";
import { checkFileSize, fileTooLargeMessage, formatBytes, LOGO_MAX_BYTES, SERVER_ACTION_BODY_LIMIT } from "@/lib/storage/upload-limits";
import { UPLOAD_RULES, validateUpload } from "@/lib/storage/upload-rules";
import { ValidationError } from "@/lib/errors";

/** Regressions for G7 bugs B1 (time zone dropdown) and B2 (oversized logo upload). Synthetic data only. */

describe("B1 — time zone dropdown and normalisation", () => {
  const runtime = Intl.supportedValuesOf("timeZone");

  it("reproduces the cause: this runtime lists the legacy Asia/Calcutta, not Asia/Kolkata", () => {
    // If a future ICU lists Asia/Kolkata, the fix still holds; this documents why it was needed.
    expect(runtime.includes("Asia/Calcutta") || runtime.includes("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
  });

  it("the options always contain the stored Asia/Kolkata, and never the legacy spelling", () => {
    const options = timeZoneOptions("Asia/Kolkata");
    expect(options).toContain("Asia/Kolkata");
    expect(options).not.toContain("Asia/Calcutta");
    expect(selectedTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("the stored value is pre-selected — the browser can no longer fall back to Africa/Abidjan", () => {
    // A <select> shows its first option when defaultValue matches none: prove it always matches.
    for (const stored of ["Asia/Kolkata", "Asia/Calcutta", "Europe/London", "America/New_York", "UTC"]) {
      const options = timeZoneOptions(stored);
      const selected = selectedTimeZone(stored);
      expect(options).toContain(selected);
      if (stored !== "Africa/Abidjan") expect(selected).not.toBe("Africa/Abidjan");
    }
    expect(timeZoneOptions("Asia/Kolkata")[0]).not.toBe("Asia/Kolkata"); // sorted list: Kolkata is not first …
    expect(selectedTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata"); // … but is the selected value
  });

  it("works even when the runtime list lacks the stored zone entirely", () => {
    const options = timeZoneOptions("Asia/Kolkata", ["Africa/Abidjan", "Europe/London"]);
    expect(options).toEqual(["Africa/Abidjan", "Asia/Kolkata", "Europe/London", "UTC"]);
  });

  it("a stored value the runtime doesn't know is kept selectable (never replaced)", () => {
    expect(timeZoneOptions("Mars/Olympus")).toContain("Mars/Olympus");
    expect(selectedTimeZone("Mars/Olympus")).toBe("Mars/Olympus");
    expect(canonicalTimeZone("Mars/Olympus")).toBeNull();
  });

  it("no stored value → Asia/Kolkata default (the documented default), not the first option", () => {
    expect(selectedTimeZone(null)).toBe("Asia/Kolkata");
    expect(selectedTimeZone(undefined)).toBe("Asia/Kolkata");
    expect(timeZoneOptions(null)).toContain("Asia/Kolkata");
  });

  it("legacy aliases map to current names; every target is valid in this runtime; options are de-duplicated", () => {
    for (const [legacy, current] of Object.entries(LEGACY_TIME_ZONE_ALIASES)) {
      expect(isValidTimeZone(current), current).toBe(true);
      if (isValidTimeZone(legacy)) expect(canonicalTimeZone(legacy)).toBe(current);
    }
    expect(canonicalTimeZone("  Asia/Calcutta ")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    const options = timeZoneOptions("Asia/Kolkata");
    expect(new Set(options).size).toBe(options.length);
    for (const legacy of Object.keys(LEGACY_TIME_ZONE_ALIASES)) expect(options).not.toContain(legacy);
  });

  const profile = (timezone: string) => ({
    name: "Demo Public School",
    shortCode: "DEMO",
    affiliationNo: "",
    board: "",
    email: "",
    website: "",
    phones: [],
    address: { line1: "1 Example Road", line2: "", city: "Demo City", district: "", state: "Demo State", pinCode: "999999", country: "India" },
    timezone,
    locale: "en-IN",
    currency: "INR",
    dateFormat: "DD/MM/YYYY",
    timings: { opensAt: "08:00", closesAt: "14:00", officeHours: "" },
  });

  it("server: a legacy name is stored in the current spelling; a current name is unchanged", () => {
    const legacy = schoolProfileSchema.safeParse(profile("Asia/Calcutta"));
    const current = schoolProfileSchema.safeParse(profile("Asia/Kolkata"));
    expect(legacy.success && legacy.data.timezone).toBe("Asia/Kolkata");
    expect(current.success && current.data.timezone).toBe("Asia/Kolkata");
  });

  it("server: unknown or empty time zones are rejected with a clear error — never defaulted", () => {
    for (const tz of ["", "   ", "Mars/Olympus", "Asia/Kolkata;DROP"]) {
      const r = schoolProfileSchema.safeParse(profile(tz));
      expect(r.success, JSON.stringify(tz)).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => i.path.join(".") === "timezone" && /valid time zone/.test(i.message))).toBe(true);
    }
  });

  it("the settings page builds its options and selection from the helpers (not raw Intl)", () => {
    const page = readFileSync(new URL("../../src/app/erp/settings/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("timeZoneOptions(settings?.timezone)");
    expect(page).toContain("selectedTimeZone(settings?.timezone)");
    expect(page).not.toContain('Intl.supportedValuesOf("timeZone")');
  });
});

describe("B2 — logo size checked before the 1 MB server-action body limit", () => {
  it("the logo limit leaves room under the Next.js body limit and matches the server rule", () => {
    expect(UPLOAD_RULES["school.logo"].maxBytes).toBe(LOGO_MAX_BYTES);
    expect(LOGO_MAX_BYTES).toBeLessThan(SERVER_ACTION_BODY_LIMIT - 64 * 1024);
  });

  it.each([
    ["exactly 800 KB", 800 * 1024, null],
    ["just over 800 KB", 800 * 1024 + 1, "The file is 800 KB; the limit is 800 KB."],
    ["900 KB", 900 * 1024, "The file is 900 KB; the limit is 800 KB."],
    ["1.4 MB (the G7 file that hit the framework limit)", 1_471_213, "The file is 1.4 MB; the limit is 800 KB."],
    ["25 MB", 25 * 1024 * 1024, "The file is 25.0 MB; the limit is 800 KB."],
  ])("browser check: %s", (_l, size, expected) => {
    expect(checkFileSize({ size }, LOGO_MAX_BYTES)).toBe(expected);
  });

  it("no file or an empty selection is left to the form's own 'choose a file' handling", () => {
    expect(checkFileSize(null, LOGO_MAX_BYTES)).toBeNull();
    expect(checkFileSize(undefined, LOGO_MAX_BYTES)).toBeNull();
    expect(checkFileSize({ size: 0 }, LOGO_MAX_BYTES)).toBeNull();
  });

  it("the browser shows exactly the server's message for the same size", () => {
    for (const size of [800 * 1024 + 1, 900 * 1024, 1_000_000]) {
      let serverMsg = "";
      try {
        validateUpload(new Uint8Array(size), "logo.png", "school.logo");
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        serverMsg = (e as Error).message;
      }
      expect(checkFileSize({ size }, LOGO_MAX_BYTES)).toBe(serverMsg);
      expect(serverMsg).toBe(fileTooLargeMessage(size, LOGO_MAX_BYTES));
    }
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("the logo form blocks oversized submissions in the browser (preventDefault before the action)", () => {
    const form = readFileSync(new URL("../../src/app/erp/settings/logo-form.tsx", import.meta.url), "utf8");
    expect(form).toMatch(/checkFileSize\([^)]*LOGO_MAX_BYTES\)/);
    expect(form).toMatch(/onSubmit=\{onSubmit\}/);
    expect(form).toMatch(/if \(problem\) e\.preventDefault\(\)/);
    expect(form).toMatch(/onChange=\{onChange\}/);
  });

  it("upload-limits stays dependency-free (safe to bundle into client components)", () => {
    const src = readFileSync(new URL("../../src/lib/storage/upload-limits.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import /m);
  });
});
