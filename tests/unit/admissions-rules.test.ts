import { describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { formatSequence, sequenceKey, validateFormat } from "@/lib/sequence";
import { assertApplicationScope } from "@/modules/admissions/admissions.policy";
import {
  APPLICATION_NO_SEQUENCE,
  assertCanDo,
  assertDeletable,
  assertDobForSession,
  assertSessionOpenForAdmissions,
  assertVersion,
  canDo,
  changedFieldNames,
  cleanText,
  DEFAULT_APPLICATION_NO_FORMAT,
  findDuplicates,
  fullNameOf,
  missingDocuments,
  missingForSubmission,
  normalizeName,
  normalizePhone,
  type AdmissionAction,
  type AdmissionStatus,
} from "@/modules/admissions/admissions.rules";
import {
  contactStepSchema,
  createDraftSchema,
  guardiansStepSchema,
  listApplicationsSchema,
  previousSchoolStepSchema,
  reasonSchema,
  setSectionSchema,
} from "@/modules/admissions/admissions.schemas";

/** Phase 2B S3 — admissions pure rules, schemas and scope (design §2.2, §2.5, §1a D5/D10). Synthetic data only. */

describe("names and phone numbers", () => {
  it("cleans, joins and normalises names (NFC, spaces, case)", () => {
    expect(cleanText("  Ananya \t  Das ")).toBe("Ananya Das");
    expect(fullNameOf("Ananya", null, " Das ")).toBe("Ananya Das");
    expect(fullNameOf("Ravi", "Kumar", "")).toBe("Ravi Kumar");
    expect(normalizeName("  ANANYA   Das")).toBe("ananya das");
    // "é" as one code point vs "e" + combining accent compare equal after NFC.
    expect(normalizeName("Renée")).toBe(normalizeName("Renée"));
  });
  it.each([
    ["9876543210", "9876543210"],
    ["+91 98765 43210", "9876543210"],
    ["919876543210", "9876543210"],
    ["09876543210", "9876543210"],
    ["(011) 2345-6789", "1123456789"], // Delhi landline with STD code
    ["080-2345 6789", "8023456789"], // Bengaluru landline
    ["12345", null],
    ["0123456789", null], // 10 digits starting with 0 — not a number
    ["98765432101", null], // 11 digits without a 0 prefix
    ["98765abcde", null],
  ])("normalizePhone(%j) → %j", (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });
});

describe("state machine (design §2.2)", () => {
  const table: Record<AdmissionAction, AdmissionStatus[]> = {
    edit: ["DRAFT"],
    delete: ["DRAFT"],
    submit: ["DRAFT"],
    startReview: ["SUBMITTED"],
    setSection: ["SUBMITTED", "UNDER_REVIEW"],
    returnToDraft: ["SUBMITTED", "UNDER_REVIEW"],
    reject: ["SUBMITTED", "UNDER_REVIEW"],
    approve: ["SUBMITTED", "UNDER_REVIEW"],
    manageDocuments: ["DRAFT", "SUBMITTED", "UNDER_REVIEW"],
  };
  const ALL: AdmissionStatus[] = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"];
  for (const [action, allowed] of Object.entries(table) as [AdmissionAction, AdmissionStatus[]][]) {
    it.each(ALL)(`${action} from %s`, (status) => {
      expect(canDo(action, status)).toBe(allowed.includes(status));
      if (allowed.includes(status)) expect(() => assertCanDo(action, status)).not.toThrow();
      else expect(() => assertCanDo(action, status)).toThrow(ConflictError);
    });
  }
  it("APPROVED and REJECTED are final: no action is possible", () => {
    for (const a of Object.keys(table) as AdmissionAction[]) {
      expect(canDo(a, "APPROVED")).toBe(false);
      expect(canDo(a, "REJECTED")).toBe(false);
    }
  });
  it("a draft that was ever submitted (has a number) can't be deleted", () => {
    expect(() => assertDeletable("DRAFT", null)).not.toThrow();
    expect(() => assertDeletable("DRAFT", "APP-2026-27-0001")).toThrow(/Reject it instead/);
    expect(() => assertDeletable("SUBMITTED", null)).toThrow(ConflictError);
  });
  it("stale versions are refused", () => {
    expect(() => assertVersion(3, 3)).not.toThrow();
    expect(() => assertVersion(4, 3)).toThrow(/changed by someone else/);
  });
  it("closed sessions take no applications; the child must be born before the session starts", () => {
    expect(() => assertSessionOpenForAdmissions("CLOSED")).toThrow(ConflictError);
    expect(() => assertSessionOpenForAdmissions("PLANNED")).not.toThrow();
    expect(() => assertSessionOpenForAdmissions("ACTIVE")).not.toThrow();
    const start = new Date("2026-04-01T00:00:00Z");
    expect(() => assertDobForSession(new Date("2020-06-15T00:00:00Z"), start)).not.toThrow();
    expect(() => assertDobForSession(start, start)).toThrow(ValidationError);
  });
});

describe("submission completeness and documents (D10)", () => {
  it("needs ≥ 1 guardian, exactly one primary, and an address", () => {
    expect(missingForSubmission({ guardians: [], address: null }).map((m) => m.step)).toEqual([2, 3]);
    expect(missingForSubmission({ guardians: [{ relation: "MOTHER", isPrimary: false }], address: {} }).map((m) => m.message)).toEqual(["Choose one primary contact."]);
    expect(missingForSubmission({ guardians: [{ relation: "MOTHER", isPrimary: true }], address: { line1: "x" } })).toEqual([]);
  });
  it("lists required documents not yet present (a warning only)", () => {
    expect(missingDocuments(["PHOTO", "BIRTH_CERTIFICATE"], [])).toEqual(["PHOTO", "BIRTH_CERTIFICATE"]);
    expect(missingDocuments(["PHOTO", "BIRTH_CERTIFICATE"], ["PHOTO", "OTHER"])).toEqual(["BIRTH_CERTIFICATE"]);
    expect(missingDocuments([], ["PHOTO"])).toEqual([]);
  });
});

describe("duplicate detection (design §2.5)", () => {
  const dob = new Date("2019-05-01T00:00:00Z");
  const me = { id: "app-1", fullNameNormalized: "ananya das", dob, guardianPhones: ["9876543210"] };
  it("same name + date of birth = possible; plus a shared guardian phone = strong (listed first)", () => {
    const r = findDuplicates(me, [
      { kind: "application", id: "app-2", fullNameNormalized: "ananya das", dob, guardianPhones: ["9123456780"] },
      { kind: "student", id: "stu-1", fullNameNormalized: "ananya das", dob, guardianPhones: ["9876543210"] },
    ]);
    expect(r).toEqual([
      { kind: "student", id: "stu-1", strength: "strong" },
      { kind: "application", id: "app-2", strength: "possible" },
    ]);
  });
  it("ignores itself, other names and other birth dates", () => {
    expect(
      findDuplicates(me, [
        { kind: "application", id: "app-1", fullNameNormalized: "ananya das", dob, guardianPhones: [] },
        { kind: "student", id: "s2", fullNameNormalized: "ananya dass", dob, guardianPhones: ["9876543210"] },
        { kind: "student", id: "s3", fullNameNormalized: "ananya das", dob: new Date("2019-05-02T00:00:00Z"), guardianPhones: ["9876543210"] },
      ]),
    ).toEqual([]);
  });
});

describe("application number (D5, D4)", () => {
  it("default APP-{SESSION}-{SEQ:4} → APP-2026-27-0001; counter per session", () => {
    expect(validateFormat(DEFAULT_APPLICATION_NO_FORMAT)).toBeNull();
    const tokens = { code: "DEMO", session: "2026-27", year: 2026 };
    expect(formatSequence(DEFAULT_APPLICATION_NO_FORMAT, 1, tokens)).toBe("APP-2026-27-0001");
    expect(formatSequence(DEFAULT_APPLICATION_NO_FORMAT, 12345, tokens)).toBe("APP-2026-27-12345"); // never truncated
    expect(sequenceKey(APPLICATION_NO_SEQUENCE, DEFAULT_APPLICATION_NO_FORMAT, tokens)).toBe("application_no:2026-27");
  });
});

describe("audit helper records field names only", () => {
  it("returns the names of changed fields (dates and JSON compared by value)", () => {
    const before = { firstName: "A", dob: new Date("2019-01-01T00:00:00Z"), address: { city: "X" }, phone: null };
    expect(changedFieldNames(before, { firstName: "A", dob: new Date("2019-01-01T00:00:00Z"), address: { city: "X" }, phone: null })).toEqual([]);
    expect(changedFieldNames(before, { firstName: "B", address: { city: "Y" }, phone: "9876543210" })).toEqual(["firstName", "address", "phone"]);
  });
});

describe("step schemas (.strict(), form strings)", () => {
  const step1 = { academicSessionId: "s1", classId: "c1", firstName: "  Ananya ", middleName: "", lastName: "Das", dob: "2019-05-01", gender: "FEMALE" };
  it("step 1 cleans names, keeps the ISO date, turns empty optional names into null", () => {
    expect(createDraftSchema.parse(step1)).toEqual({ ...step1, firstName: "Ananya", middleName: null });
  });
  it.each([
    ["digits in a name", { firstName: "Ananya2" }],
    ["empty first name", { firstName: "  " }],
    ["impossible date", { dob: "2019-02-30" }],
    ["before 1990", { dob: "1989-12-31" }],
    ["unknown gender", { gender: "X" }],
    ["extra key", { aadhaar: "123" }],
  ])("step 1 rejects %s", (_l, over) => {
    expect(createDraftSchema.safeParse({ ...step1, ...over }).success).toBe(false);
  });
  it("accepts names in other scripts, apostrophes, dots and hyphens", () => {
    for (const firstName of ["अनन्या", "D'Souza", "J. K.", "Mary-Ann"]) expect(createDraftSchema.safeParse({ ...step1, firstName }).success, firstName).toBe(true);
  });

  const g = (over: Record<string, unknown> = {}) => ({ relation: "MOTHER", name: "Rita Das", phone: "+91 98765 43210", altPhone: "", email: "", occupation: "", isPrimary: true, isEmergencyContact: false, ...over });
  it("step 2 normalises phones and needs exactly one primary, ≤ 1 father and ≤ 1 mother", () => {
    const ok = guardiansStepSchema.parse({ id: "a", version: "1", guardians: [g()] });
    expect(ok.guardians[0]).toMatchObject({ phone: "9876543210", altPhone: null, email: null, occupation: null });
    expect(guardiansStepSchema.safeParse({ id: "a", version: "1", guardians: [g({ isPrimary: false })] }).success).toBe(false);
    expect(guardiansStepSchema.safeParse({ id: "a", version: "1", guardians: [g(), g({ isPrimary: false })] }).success).toBe(false); // two mothers
    expect(guardiansStepSchema.safeParse({ id: "a", version: "1", guardians: [g(), g({ relation: "FATHER", isPrimary: true })] }).success).toBe(false); // two primaries
    expect(guardiansStepSchema.safeParse({ id: "a", version: "1", guardians: [] }).success).toBe(false);
    expect(guardiansStepSchema.safeParse({ id: "a", version: "1", guardians: [g({ phone: "12345" })] }).success).toBe(false);
    expect(guardiansStepSchema.safeParse({ id: "a", version: "1", guardians: [g({ email: "not-an-email" })] }).success).toBe(false);
    expect(guardiansStepSchema.safeParse({ id: "a", version: "", guardians: [g()] }).success).toBe(false);
  });

  it("step 3 requires the address; contact fields optional", () => {
    const address = { line1: "1 Example Road", line2: "", city: "Sampletown", district: "", state: "Example State", pinCode: "110001", country: "India" };
    expect(contactStepSchema.parse({ id: "a", version: "2", phone: "", email: "", address })).toMatchObject({ phone: null, email: null, version: 2 });
    expect(contactStepSchema.safeParse({ id: "a", version: "2", phone: "", email: "", address: { ...address, pinCode: "11" } }).success).toBe(false);
  });

  it("step 4: all optional; year must be 4 digits", () => {
    const empty = { name: "", board: "", lastClass: "", yearLeft: "", tcNumber: "" };
    expect(previousSchoolStepSchema.parse({ id: "a", version: "1", previousSchool: empty }).previousSchool).toEqual({ name: null, board: null, lastClass: null, yearLeft: null, tcNumber: null });
    expect(previousSchoolStepSchema.safeParse({ id: "a", version: "1", previousSchool: { ...empty, yearLeft: "25" } }).success).toBe(false);
  });

  it("workflow: reasons need ≥ 3 characters; section id required; list filters bounded", () => {
    expect(reasonSchema.safeParse({ id: "a", version: "1", reason: " ok " }).success).toBe(false);
    expect(reasonSchema.parse({ id: "a", version: "1", reason: "  TC  missing " }).reason).toBe("TC missing");
    expect(setSectionSchema.safeParse({ id: "a", version: "1", sectionId: "" }).success).toBe(false);
    expect(listApplicationsSchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(listApplicationsSchema.safeParse({ pageSize: "500" }).success).toBe(false);
    expect(listApplicationsSchema.safeParse({ status: "DELETED" }).success).toBe(false);
  });
});

describe("application scope policy", () => {
  it("only ALL scope may see applications", () => {
    expect(() => assertApplicationScope("ALL")).not.toThrow();
    for (const s of ["ASSIGNED", "CHILDREN", "SELF"] as const) expect(() => assertApplicationScope(s)).toThrow(ForbiddenError);
  });
});
