import { describe, expect, it } from "vitest";
import { fromError } from "@/lib/action-state";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { approveSchema } from "@/modules/admissions/admissions.schemas";
import { APPROVAL_LOCK_TIMEOUT } from "@/modules/admissions/admissions.service";
import {
  assertAdmissionDate,
  assertDuplicateOverride,
  assertSeatAvailable,
  DEFAULT_ADMISSION_NO_FORMAT,
  DEFAULT_STUDENT_ID_FORMAT,
  planPermanentIds,
  renderId,
  resolveGuardianLinks,
} from "@/modules/students/students.rules";

/** Phase 2B S5 — registration rules (D1, D4, D9), approval input, busy mapping (KI-044 / D11). Synthetic data. */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const session = { name: "2026-27", startDate: d("2026-04-01"), endDate: d("2027-03-31") };

describe("permanent IDs (D4: {YYYY} = session start year)", () => {
  const base = { studentIdFormat: null, admissionNoFormat: null, schoolCode: "DEMO", sessionName: session.name, sessionStart: session.startDate, classCode: "C01" };
  it("defaults: DEMO-2026-0001 and ADM-2026-0001, counters per start year", () => {
    const ids = planPermanentIds(base);
    expect([ids.studentId.format, ids.admissionNo.format]).toEqual([DEFAULT_STUDENT_ID_FORMAT, DEFAULT_ADMISSION_NO_FORMAT]);
    expect([renderId(ids.studentId, 1), renderId(ids.admissionNo, 1)]).toEqual(["DEMO-2026-0001", "ADM-2026-0001"]);
    expect([ids.studentId.key, ids.admissionNo.key]).toEqual(["student_id:2026", "admission_no:2026"]);
  });
  it("the year comes from the session, not the approval date (a January 2027 approval in 2026-27 is still 2026)", () => {
    const ids = planPermanentIds({ ...base, sessionStart: d("2026-04-01") });
    expect(renderId(ids.studentId, 42)).toBe("DEMO-2026-0042");
    const next = planPermanentIds({ ...base, sessionName: "2027-28", sessionStart: d("2027-04-01") });
    expect(next.studentId.key).toBe("student_id:2027"); // a new year starts its own counter
  });
  it("configured formats are used; a format without {YYYY} shares one counter", () => {
    const ids = planPermanentIds({ ...base, studentIdFormat: "{CODE}/{SEQ:5}", admissionNoFormat: "A-{YY}-{SEQ:3}" });
    expect([renderId(ids.studentId, 7), renderId(ids.admissionNo, 7)]).toEqual(["DEMO/00007", "A-26-007"]);
    expect([ids.studentId.key, ids.admissionNo.key]).toEqual(["student_id:all", "admission_no:2026"]);
  });
  it("never truncates (10000 stays 10000) and refuses an invalid configured format", () => {
    expect(renderId(planPermanentIds(base).studentId, 10_000)).toBe("DEMO-2026-10000");
    expect(() => planPermanentIds({ ...base, studentIdFormat: "{CODE}-{YYYY}" })).toThrow(ConflictError); // no {SEQ}
    expect(() => planPermanentIds({ ...base, admissionNoFormat: "ADM-{FOO}-{SEQ}" })).toThrow(/admission number format/);
  });
});

describe("admission date and capacity", () => {
  it("must fall inside the session and after the date of birth", () => {
    expect(() => assertAdmissionDate(d("2026-06-15"), session, d("2019-05-01"))).not.toThrow();
    expect(() => assertAdmissionDate(d("2026-03-31"), session, d("2019-05-01"))).toThrow(ValidationError);
    expect(() => assertAdmissionDate(d("2027-04-01"), session, d("2019-05-01"))).toThrow(ValidationError);
    expect(() => assertAdmissionDate(d("2026-04-01"), session, d("2026-04-01"))).toThrow(/after the date of birth/);
  });
  it("a seat is free only while ACTIVE enrollments < capacity", () => {
    expect(() => assertSeatAvailable(39, 40, "C01-A")).not.toThrow();
    expect(() => assertSeatAvailable(40, 40, "C01-A")).toThrow(/C01-A is full \(40\/40\)/);
    expect(() => assertSeatAvailable(41, 40, "C01-A")).toThrow(ConflictError);
  });
});

describe("guardian links (D9: explicit, same phone, never automatic)", () => {
  const applicants = [
    { id: "ag1", phone: "9876500001" },
    { id: "ag2", phone: "9876500002" },
  ];
  const existing = [
    { id: "g1", phone: "9876500001", deleted: false },
    { id: "g2", phone: "9876500002", deleted: false },
    { id: "gx", phone: "9876500001", deleted: true },
  ];
  it("no choice = create new for everyone (no automatic link even when phones match)", () => {
    expect([...resolveGuardianLinks(applicants, {}, existing)]).toEqual([["ag1", null], ["ag2", null]]);
  });
  it("links an explicitly chosen guardian with the same phone", () => {
    expect([...resolveGuardianLinks(applicants, { ag1: "g1", ag2: null }, existing)]).toEqual([["ag1", "g1"], ["ag2", null]]);
  });
  it.each<[string, Record<string, string | null>]>([
    ["a different phone number", { ag1: "g2" }],
    ["a deleted guardian", { ag1: "gx" }],
    ["an unknown guardian", { ag1: "nope" }],
    ["an id from another application", { agZ: null }],
  ])("refuses %s", (_l, links) => {
    expect(() => resolveGuardianLinks(applicants, links, existing)).toThrow(ValidationError);
  });
  it("refuses linking two applicant guardians to the same person", () => {
    const sharedPhone = [
      { id: "ag1", phone: "9876500001" },
      { id: "ag2", phone: "9876500001" },
    ];
    expect(() => resolveGuardianLinks(sharedPhone, { ag1: "g1", ag2: "g1" }, existing)).toThrow(/same person/);
  });
});

describe("duplicate override", () => {
  it("needed only when there are matches", () => {
    expect(() => assertDuplicateOverride(0, null)).not.toThrow();
    expect(() => assertDuplicateOverride(2, null)).toThrow(/2 possible matches/);
    expect(() => assertDuplicateOverride(1, "Different child, same name (twins checked)")).not.toThrow();
  });
});

describe("approval input", () => {
  const ok = { id: "a", version: "2", admissionDate: "2026-06-15", duplicateOverride: "", guardianLinks: { ag1: null, ag2: "g1" } };
  it("parses; empty override → null; version from the form string", () => {
    expect(approveSchema.parse(ok)).toEqual({ id: "a", version: 2, admissionDate: "2026-06-15", duplicateOverride: null, guardianLinks: { ag1: null, ag2: "g1" } });
  });
  it.each([
    ["impossible date", { admissionDate: "2026-02-30" }],
    ["too-short override", { duplicateOverride: "ok" }],
    ["extra key (studentCode can't be chosen by the client)", { studentCode: "DEMO-2026-0001" }],
    ["missing version", { version: "" }],
  ])("refuses %s", (_l, over) => {
    expect(approveSchema.safeParse({ ...ok, ...over }).success).toBe(false);
  });
});

describe("KI-044 busy detection (D11)", () => {
  it.each<[string, unknown, boolean]>([
    ["Prisma P2028 (transaction couldn't start / expired)", { code: "P2028", message: "Transaction API error: Unable to start a transaction in the given time." }, true],
    ["Postgres lock_timeout 55P03", { code: "55P03" }, true],
    ["deadlock 40P01 (Postgres rolled one back)", { code: "40P01" }, true],
    ["adapter cause 55P03", { code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "55P03" } } } }, true],
    ["adapter TransactionAlreadyClosed", { meta: { driverAdapterError: { cause: { kind: "TransactionAlreadyClosed" } } } }, true],
    ["message: lock timeout", new Error("canceling statement due to lock timeout"), true],
    ["unique violation is NOT busy", { code: "P2002" }, false],
    ["an AppError is NOT busy", new ConflictError("full"), false],
    ["null", null, false],
  ])("%s → %s", (_l, e, busy) => {
    expect(isTransactionBusy(e)).toBe(busy);
  });
  it("server actions show the friendly busy message, never the Prisma text", () => {
    const state = fromError({ code: "P2028", message: "Transaction API error: Unable to start a transaction in the given time." });
    expect(state.error).toBe("The system is busy. Please try again in a moment.");
  });
  it("approvals use a ~5 s lock timeout", () => {
    expect(APPROVAL_LOCK_TIMEOUT).toBe("5s");
  });
});

describe("today in the school time zone", () => {
  it("uses the school's zone, not UTC", () => {
    const lateUtc = new Date("2026-06-15T20:00:00.000Z"); // 01:30 on 16 June in Kolkata
    expect(todayInTimeZone("Asia/Kolkata", lateUtc)).toBe("2026-06-16");
    expect(todayInTimeZone("UTC", lateUtc)).toBe("2026-06-15");
  });
});
