import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "@/lib/csv";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { exportErrorCode, EXPORT_MESSAGES, isExportCode } from "@/lib/http/export-errors";
import { privateFileResponse } from "@/lib/http/file-response";
import { RateLimitedError, ServiceBusyError, UnauthenticatedError } from "@/lib/errors";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { activeNavHref, NAV_ITEMS, visibleNavItems } from "@/components/erp/nav-items";
import { cleanText, fullNameOf, normalizeName, normalizePhone } from "@/modules/students/person-fields";
import * as admissionsRules from "@/modules/admissions/admissions.rules";
import { studentScopeOf, studentScopeWhere } from "@/modules/students/students.policy";
import {
  assertDobBeforeAdmission,
  assertExportSize,
  assertFieldsEditable,
  assertLeavingDate,
  assertStatusChange,
  changedKeys,
  editableGuardianFields,
  editableStudentFields,
  EXPORT_MAX_ROWS,
  pick,
  STUDENT_CONTACT_FIELDS,
} from "@/modules/students/students.rules";
import { changeStatusSchema, exportStudentsSchema, listStudentsSchema, updateGuardianSchema, updateStudentSchema } from "@/modules/students/students.schemas";

/** Phase 2B S7 — student records: pure rules, policy, schemas, CSV, nav and the RBAC matrix (design §4.2). */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ADDRESS = { line1: "12 Demo Street", line2: "", city: "Demo City", district: "", state: "Demo State", pinCode: "110001", country: "India" };

function ctxFor(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(`unknown role ${roleKey}`);
  const permissions = new Map<PermissionKey, Set<Scope>>();
  for (const g of role.grants) {
    const { key, scope } = normalizeGrant(g);
    permissions.set(key, (permissions.get(key) ?? new Set<Scope>()).add(scope));
  }
  return { userId: "u1", username: "demo", displayName: "Demo", roleKeys: [roleKey], isSuperAdmin: roleKey === "SUPER_ADMIN", permissions, sessionId: "s1" };
}

describe("CSV export building (injection-safe)", () => {
  it("prefixes formula starters with an apostrophe", () => {
    for (const v of ["=1+1", "+91 98765", "-2", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(v).replace(/^"|"$/g, "").startsWith("'")).toBe(true);
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
  });
  it("quotes commas, quotes, newlines and edge spaces; leaves plain text alone", () => {
    expect(csvCell("Das, Ananya")).toBe('"Das, Ananya"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell(" x")).toBe('" x"');
    expect(csvCell("Ananya Das")).toBe("Ananya Das");
    expect(csvCell("अनन्या")).toBe("अनन्या");
  });
  it("renders null/undefined as empty and numbers as text", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(7)).toBe("7");
  });
  it("adds a UTF-8 BOM and CRLF line ends", () => {
    const csv = toCsv(["A", "B"], [["1", null], ["=x", "y"]]);
    expect(csv).toBe("﻿A,B\r\n1,\r\n'=x,y\r\n");
  });
});

describe("shared person fields (moved from admissions, same behaviour)", () => {
  it("admissions.rules re-exports the same functions", () => {
    expect(admissionsRules.normalizePhone).toBe(normalizePhone);
    expect(admissionsRules.cleanText).toBe(cleanText);
    expect(admissionsRules.normalizeName).toBe(normalizeName);
    expect(admissionsRules.fullNameOf).toBe(fullNameOf);
  });
  it("normalises phones and names", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("9876543210");
    expect(normalizePhone("011 2345 6789")).toBe("1123456789");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizeName("  Ananya   DAS ")).toBe("ananya das");
    expect(fullNameOf("Ananya", null, " Das ")).toBe("Ananya Das");
  });
});

describe("status changes", () => {
  it("allows ACTIVE → transferred / withdrawn / graduated", () => {
    for (const to of ["TRANSFERRED", "WITHDRAWN", "GRADUATED"] as const) expect(() => assertStatusChange("ACTIVE", to)).not.toThrow();
  });
  it("refuses leaving twice and re-admission (not offered yet)", () => {
    expect(() => assertStatusChange("TRANSFERRED", "WITHDRAWN")).toThrow(ConflictError);
    expect(() => assertStatusChange("WITHDRAWN", "ACTIVE")).toThrow(ValidationError);
    expect(() => assertStatusChange("ACTIVE", "ACTIVE")).toThrow(ValidationError);
  });
  it("leaving date: not before the enrollment started, not in the future, today allowed", () => {
    expect(() => assertLeavingDate(d("2026-04-01"), d("2026-04-01"), "2026-11-10")).not.toThrow();
    expect(() => assertLeavingDate(d("2026-11-10"), d("2026-04-01"), "2026-11-10")).not.toThrow();
    expect(() => assertLeavingDate(d("2026-03-31"), d("2026-04-01"), "2026-11-10")).toThrow(/before the student joined/);
    expect(() => assertLeavingDate(d("2026-11-11"), d("2026-04-01"), "2026-11-10")).toThrow(/future/);
  });
  it("date of birth must stay before the admission date", () => {
    expect(() => assertDobBeforeAdmission(d("2019-05-01"), d("2026-04-01"))).not.toThrow();
    expect(() => assertDobBeforeAdmission(d("2026-04-01"), d("2026-04-01"))).toThrow(ValidationError);
  });
});

describe("field-level edits (design §4.2)", () => {
  it("ALL edits identity and contact; ASSIGNED (class teacher) contact only", () => {
    expect(editableStudentFields("ALL")).toEqual(expect.arrayContaining(["firstName", "dob", "gender", "phone", "email", "address"]));
    expect(editableStudentFields("ASSIGNED")).toEqual(STUDENT_CONTACT_FIELDS);
    expect(editableGuardianFields("ASSIGNED")).toEqual(["phone", "altPhone", "email"]);
    expect(editableGuardianFields("ALL")).toEqual(expect.arrayContaining(["name", "occupation", "phone"]));
  });
  it("permanent IDs are never editable", () => {
    for (const scope of ["ALL", "ASSIGNED"] as const) {
      expect(editableStudentFields(scope)).not.toContain("studentCode");
      expect(editableStudentFields(scope)).not.toContain("admissionNo");
    }
  });
  it("refuses a class teacher's change to a name, allows a contact change", () => {
    expect(() => assertFieldsEditable(["phone", "address"], editableStudentFields("ASSIGNED"))).not.toThrow();
    expect(() => assertFieldsEditable(["phone", "firstName"], editableStudentFields("ASSIGNED"))).toThrow(ForbiddenError);
    expect(() => assertFieldsEditable(["name"], editableGuardianFields("ASSIGNED"))).toThrow(ForbiddenError);
  });
  it("changedKeys ignores undefined (= not sent) and compares dates and addresses by value", () => {
    const before = { firstName: "Ananya", dob: d("2019-05-01"), phone: null, address: ADDRESS };
    expect(changedKeys(before, { firstName: undefined, dob: d("2019-05-01"), phone: null, address: { ...ADDRESS } })).toEqual([]);
    expect(changedKeys(before, { firstName: "Anaya", dob: d("2019-05-02"), phone: "9876543210", address: { ...ADDRESS, city: "Other" } })).toEqual(["firstName", "dob", "phone", "address"]);
    expect(pick({ a: 1, b: 2, c: 3 }, ["a", "c", "z"])).toEqual({ a: 1, c: 3 });
  });
});

describe("export size", () => {
  it(`allows up to ${EXPORT_MAX_ROWS} rows and refuses more (never truncates)`, () => {
    expect(() => assertExportSize(EXPORT_MAX_ROWS)).not.toThrow();
    expect(() => assertExportSize(EXPORT_MAX_ROWS + 1)).toThrow(ConflictError);
  });
  it("maps service errors to fixed export codes", () => {
    expect(exportErrorCode(new RateLimitedError())).toBe("rate_limited");
    expect(exportErrorCode(new ServiceBusyError())).toBe("busy");
    expect(exportErrorCode(new UnauthenticatedError())).toBe("signed_out");
    expect(exportErrorCode(new ForbiddenError())).toBe("forbidden");
    expect(exportErrorCode(new ConflictError("too many"))).toBe("too_many");
    expect(exportErrorCode(new ValidationError("bad"))).toBe("invalid");
    expect(exportErrorCode(new Error("x"))).toBe("failed");
    expect(isExportCode("too_many")).toBe(true);
    expect(isExportCode("<script>")).toBe(false);
    expect(isExportCode("toString")).toBe(false);
    expect(Object.keys(EXPORT_MESSAGES)).toHaveLength(7);
  });
});

describe("record scope policy", () => {
  it("ALL and ASSIGNED are usable; SELF and CHILDREN are refused until the portal links users to students", () => {
    expect(studentScopeOf("ALL")).toBe("ALL");
    expect(studentScopeOf("ASSIGNED")).toBe("ASSIGNED");
    expect(() => studentScopeOf("SELF")).toThrow(ForbiddenError);
    expect(() => studentScopeOf("CHILDREN")).toThrow(ForbiddenError);
  });
  it("always excludes soft-deleted students; ASSIGNED = ACTIVE enrollment in the user's class-teacher section", () => {
    expect(studentScopeWhere("ALL", "u1")).toEqual({ deletedAt: null });
    expect(studentScopeWhere("ASSIGNED", "u9")).toEqual({ deletedAt: null, enrollments: { some: { status: "ACTIVE", section: { classTeacherId: "u9", academicSession: { status: { not: "CLOSED" } } } } } }); // S-02: closed sessions end class-teacher access
  });
});

describe("schemas (.strict)", () => {
  const base = { id: "cmstudent00001", version: "3", phone: "", email: "", address: ADDRESS };
  it("accepts a contact-only edit (class teacher form) with identity fields absent", () => {
    const r = updateStudentSchema.parse(base);
    expect(r.version).toBe(3);
    expect(r.firstName).toBeUndefined();
    expect(r.phone).toBeNull();
  });
  it("refuses permanent IDs, status and unknown fields", () => {
    for (const extra of [{ studentCode: "X-1" }, { admissionNo: "ADM-1" }, { status: "ACTIVE" }, { sectionId: "s" }]) {
      expect(updateStudentSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
  it("validates identity fields when sent", () => {
    expect(updateStudentSchema.safeParse({ ...base, firstName: "", dob: "2019-05-01" }).success).toBe(false);
    expect(updateStudentSchema.safeParse({ ...base, dob: "1989-12-31" }).success).toBe(false);
    expect(updateStudentSchema.safeParse({ ...base, dob: "2019-02-30" }).success).toBe(false);
    expect(updateStudentSchema.parse({ ...base, firstName: " Ananya ", middleName: "", gender: "FEMALE" })).toMatchObject({ firstName: "Ananya", middleName: null, gender: "FEMALE" });
  });
  it("guardian edit requires a phone and normalises it", () => {
    const g = { studentId: "cmstudent00001", guardianId: "cmguardian0001", phone: "+91 98765 43210", altPhone: "", email: "" };
    expect(updateGuardianSchema.parse(g).phone).toBe("9876543210");
    expect(updateGuardianSchema.safeParse({ ...g, phone: "" }).success).toBe(false);
    expect(updateGuardianSchema.safeParse({ ...g, relation: "FATHER" }).success).toBe(false);
  });
  it("status change: leaving statuses only, valid date, reason of 3+ characters", () => {
    const s = { id: "cmstudent00001", version: "1", toStatus: "TRANSFERRED", effectiveDate: "2026-11-01", reason: "Family moved" };
    expect(changeStatusSchema.parse(s).toStatus).toBe("TRANSFERRED");
    expect(changeStatusSchema.safeParse({ ...s, toStatus: "ACTIVE" }).success).toBe(false);
    expect(changeStatusSchema.safeParse({ ...s, reason: "no" }).success).toBe(false);
    expect(changeStatusSchema.safeParse({ ...s, effectiveDate: "01/11/2026" }).success).toBe(false);
  });
  it("directory paging is bounded; export takes no paging", () => {
    expect(listStudentsSchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(listStudentsSchema.parse({}).pageSize).toBe(25);
    expect(exportStudentsSchema.safeParse({ page: "2" }).success).toBe(false);
    expect(exportStudentsSchema.parse({ status: "ACTIVE", q: " das " })).toEqual({ status: "ACTIVE", q: "das" });
  });
});

describe("navigation", () => {
  it("highlights only the most specific item", () => {
    expect(activeNavHref("/erp/students", NAV_ITEMS)).toBe("/erp/students");
    expect(activeNavHref("/erp/students/abc/edit", NAV_ITEMS)).toBe("/erp/students");
    expect(activeNavHref("/erp/students/registration/sec1", NAV_ITEMS)).toBe("/erp/students/registration");
    expect(activeNavHref("/erp", NAV_ITEMS)).toBe("/erp");
    expect(activeNavHref("/erp/studentsx", NAV_ITEMS)).toBeNull();
  });
});

describe("RBAC matrix for student records (design §4.2)", () => {
  const canExport = (role: string) => {
    const c = ctxFor(role);
    return hasPermission(c, "export.run") && hasPermission(c, "student.read") && scopeFor(c, "admission.read") === "ALL";
  };
  it("export: Super Admin and School Admin only — never the Accountant (D8), Teacher or Admission Officer without export.run", () => {
    expect(canExport("SUPER_ADMIN")).toBe(true);
    expect(canExport("SCHOOL_ADMIN")).toBe(true);
    expect(canExport("ACCOUNTANT")).toBe(false);
    expect(canExport("TEACHER")).toBe(false);
    expect(canExport("CLASS_TEACHER")).toBe(false);
    expect(canExport("PRINCIPAL")).toBe(false);
  });
  it("student.read scopes: Class Teacher and Teacher ASSIGNED; Accountant ALL (D8)", () => {
    expect(scopeFor(ctxFor("CLASS_TEACHER"), "student.read")).toBe("ASSIGNED");
    expect(scopeFor(ctxFor("TEACHER"), "student.read")).toBe("ASSIGNED");
    expect(scopeFor(ctxFor("ACCOUNTANT"), "student.read")).toBe("ALL");
  });
  it("edits: Class Teacher ASSIGNED (contact only); Teacher and Accountant none", () => {
    expect(scopeFor(ctxFor("CLASS_TEACHER"), "student.update")).toBe("ASSIGNED");
    expect(hasPermission(ctxFor("TEACHER"), "student.update")).toBe(false);
    expect(hasPermission(ctxFor("ACCOUNTANT"), "student.update")).toBe(false);
    expect(scopeFor(ctxFor("SCHOOL_ADMIN"), "student.update")).toBe("ALL");
  });
  it("status changes: School Admin only among staff roles (student.transfer)", () => {
    expect(hasPermission(ctxFor("SCHOOL_ADMIN"), "student.transfer")).toBe(true);
    for (const r of ["PRINCIPAL", "ADMISSION_OFFICER", "CLASS_TEACHER", "TEACHER", "ACCOUNTANT"]) expect(hasPermission(ctxFor(r), "student.transfer")).toBe(false);
  });
  it("documents on the profile need student.document.read (Accountant and teachers don't hold it)", () => {
    for (const r of ["ACCOUNTANT", "TEACHER", "CLASS_TEACHER"]) expect(hasPermission(ctxFor(r), "student.document.read")).toBe(false);
  });
});

describe("private file responses", () => {
  it("PDFs: attachment, sandbox CSP; images inline; never cached", () => {
    const pdf = privateFileResponse({ bytes: new Uint8Array([37, 80, 68, 70]), mimeType: "application/pdf", originalName: "जन्म \"bc\".pdf" });
    expect(pdf.headers.get("content-disposition")).toMatch(/^attachment; filename="____ bc.pdf"; filename\*=UTF-8''/);
    expect(pdf.headers.get("content-security-policy")).toBe("sandbox");
    expect(pdf.headers.get("cache-control")).toBe("private, no-store");
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    const img = privateFileResponse({ bytes: new Uint8Array([1]), mimeType: "image/jpeg", originalName: "photo.jpg" });
    expect(img.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(img.headers.get("content-security-policy")).toBeNull();
  });
});

describe("menu: Students only for scopes the directory serves (S7 browser review)", () => {
  const labels = (role: string) => {
    const c = ctxFor(role);
    return visibleNavItems((p) => hasPermission(c, p), (p) => scopeFor(c, p)).map((i) => i.label);
  };
  it("Parent (CHILDREN) and Student (SELF) don't get a dead 'Students' link; no grant changed", () => {
    expect(scopeFor(ctxFor("PARENT"), "student.read")).toBe("CHILDREN");
    expect(scopeFor(ctxFor("STUDENT"), "student.read")).toBe("SELF");
    expect(labels("PARENT")).not.toContain("Students");
    expect(labels("STUDENT")).not.toContain("Students");
  });
  it("ALL and ASSIGNED readers keep it", () => {
    for (const r of ["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL", "ADMISSION_OFFICER", "ACCOUNTANT", "LIBRARIAN", "CLASS_TEACHER", "TEACHER"]) expect(labels(r)).toContain("Students");
  });
  it("Accountant: Students (read, D8) but no Admissions, Roll numbers, Users, Roles or Settings", () => {
    expect(labels("ACCOUNTANT")).toEqual(["Dashboard", "Students", "Leave", "Staff attendance", "Payroll", "My salary slips", "Fees", "My account"]);
  });
});
