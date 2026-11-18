import { describe, expect, it } from "vitest";
import { academicSessionSchema, isValidTimeZone, schoolProfileSchema } from "@/modules/settings/settings.schemas";
import {
  assertCanBeCurrent,
  assertEditable,
  assertNoOverlap,
  assertSessionShape,
  assertStatusTransition,
  parseDateOnly,
  rangesOverlap,
  type SessionLike,
} from "@/modules/settings/settings.rules";
import { ConflictError, ValidationError } from "@/lib/errors";

const validProfile = {
  name: "Demo Public School",
  shortCode: "dps",
  affiliationNo: "",
  board: "CBSE",
  email: "Office@Example.TEST",
  website: "https://school.example.test",
  phones: ["+91 98765 43210", "011-2345-6789"],
  address: { line1: "12 School Road", line2: "", city: "Patna", district: "", state: "Bihar", pinCode: "800001", country: "India" },
  timezone: "Asia/Kolkata",
  timings: { opensAt: "08:00", closesAt: "14:30", officeHours: "" },
};

describe("school profile validation", () => {
  it("normalises valid input", () => {
    const p = schoolProfileSchema.parse(validProfile);
    expect(p.shortCode).toBe("DPS");
    expect(p.email).toBe("office@example.test");
    expect(p.phones).toEqual(["+919876543210", "01123456789"]);
    expect(p.affiliationNo).toBeNull();
    expect(p.address.line2).toBeNull();
    // Regional fields default to Indian conventions when omitted (matches the DB defaults).
    expect([p.locale, p.currency, p.dateFormat]).toEqual(["en-IN", "INR", "DD/MM/YYYY"]);
  });
  it("accepts supported regional settings and upper-cases the currency", () => {
    const p = schoolProfileSchema.parse({ ...validProfile, locale: "hi-IN", currency: "usd", dateFormat: "YYYY-MM-DD" });
    expect([p.locale, p.currency, p.dateFormat]).toEqual(["hi-IN", "USD", "YYYY-MM-DD"]);
  });
  it.each([
    ["short code with symbols", { shortCode: "D-PS" }],
    ["short code starting with a digit", { shortCode: "1DPS" }],
    ["http website", { website: "http://school.example.test" }],
    ["javascript website", { website: "javascript:alert(1)" }],
    ["bad phone", { phones: ["12345"] }],
    ["too many phones", { phones: ["9876543210", "9876543211", "9876543212", "9876543213"] }],
    ["bad PIN", { address: { ...validProfile.address, pinCode: "080001" } }],
    ["unknown time zone", { timezone: "Mars/Olympus" }],
    ["closing before opening", { timings: { opensAt: "14:00", closesAt: "08:00", officeHours: "" } }],
    ["unknown field (strict)", { isSuperAdmin: true }],
    ["unsupported locale", { locale: "xx-YY" }],
    ["unknown currency", { currency: "ABC" }],
    ["free-text date format", { dateFormat: "%d/%m/%Y" }],
  ])("rejects %s", (_label, patch) => {
    expect(schoolProfileSchema.safeParse({ ...validProfile, ...patch }).success).toBe(false);
  });
  it("knows real IANA time zones", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
    expect(isValidTimeZone("Nowhere/Land")).toBe(false);
  });
});

const d = parseDateOnly;
const session = (id: string, name: string, start: string, end: string, status: SessionLike["status"] = "PLANNED"): SessionLike => ({
  id,
  name,
  startDate: d(start),
  endDate: d(end),
  status,
});

describe("academic session shape", () => {
  it("accepts a normal Indian academic year", () => {
    expect(() => assertSessionShape("2026-27", d("2026-04-01"), d("2027-03-31"))).not.toThrow();
    expect(academicSessionSchema.safeParse({ name: "2026-27", startDate: "2026-04-01", endDate: "2027-03-31" }).success).toBe(true);
  });
  it("rejects malformed names and impossible dates", () => {
    expect(academicSessionSchema.safeParse({ name: "2026-2027", startDate: "2026-04-01", endDate: "2027-03-31" }).success).toBe(false);
    expect(() => parseDateOnly("2026-02-30")).toThrow(ValidationError);
  });
  it("requires end after start, ≤ 18 months, consecutive years matching the dates", () => {
    expect(() => assertSessionShape("2026-27", d("2027-03-31"), d("2026-04-01"))).toThrow(/after the start/);
    expect(() => assertSessionShape("2026-27", d("2026-01-01"), d("2027-12-31"))).toThrow(/18 months/);
    expect(() => assertSessionShape("2026-28", d("2026-04-01"), d("2027-03-31"))).toThrow(/consecutive/);
    expect(() => assertSessionShape("2026-27", d("2025-04-01"), d("2026-03-31"))).toThrow(/match/);
  });
  it("handles the century boundary", () => {
    expect(() => assertSessionShape("2099-00", d("2099-04-01"), d("2100-03-31"))).not.toThrow();
  });
});

describe("overlap and lifecycle rules", () => {
  const existing = [session("a", "2025-26", "2025-04-01", "2026-03-31", "ACTIVE")];
  it("detects inclusive overlaps", () => {
    expect(rangesOverlap(d("2026-03-31"), d("2027-03-30"), d("2025-04-01"), d("2026-03-31"))).toBe(true);
    expect(() => assertNoOverlap({ startDate: d("2026-03-15"), endDate: d("2027-03-14") }, existing)).toThrow(/overlap with session 2025-26/);
    expect(() => assertNoOverlap({ startDate: d("2026-04-01"), endDate: d("2027-03-31") }, existing)).not.toThrow();
    expect(() => assertNoOverlap({ id: "a", startDate: d("2025-04-01"), endDate: d("2026-03-31") }, existing)).not.toThrow(); // itself
  });
  it("allows PLANNED→ACTIVE→CLOSED and PLANNED→CLOSED only", () => {
    expect(() => assertStatusTransition(session("x", "2026-27", "2026-04-01", "2027-03-31", "PLANNED"), "ACTIVE", null)).not.toThrow();
    expect(() => assertStatusTransition(session("x", "2026-27", "2026-04-01", "2027-03-31", "PLANNED"), "CLOSED", null)).not.toThrow();
    expect(() => assertStatusTransition(session("x", "2026-27", "2026-04-01", "2027-03-31", "ACTIVE"), "CLOSED", null)).not.toThrow();
    expect(() => assertStatusTransition(session("x", "2026-27", "2026-04-01", "2027-03-31", "ACTIVE"), "PLANNED", null)).toThrow(ConflictError);
    expect(() => assertStatusTransition(session("x", "2026-27", "2026-04-01", "2027-03-31", "CLOSED"), "ACTIVE", null)).toThrow(ConflictError);
  });
  it("the current session can't be closed; only an active session can be current", () => {
    const active = session("x", "2026-27", "2026-04-01", "2027-03-31", "ACTIVE");
    expect(() => assertStatusTransition(active, "CLOSED", "x")).toThrow(/another current session/);
    expect(() => assertCanBeCurrent(active)).not.toThrow();
    expect(() => assertCanBeCurrent({ ...active, status: "PLANNED" })).toThrow(/active session/);
  });
  it("only planned sessions are editable", () => {
    expect(() => assertEditable(session("x", "2026-27", "2026-04-01", "2027-03-31", "PLANNED"))).not.toThrow();
    expect(() => assertEditable(session("x", "2026-27", "2026-04-01", "2027-03-31", "ACTIVE"))).toThrow(ConflictError);
  });
});
