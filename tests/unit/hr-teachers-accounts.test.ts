import { describe, expect, it } from "vitest";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { ForbiddenError } from "@/lib/errors";
import { linkAccountSchema, teacherProfileSchema, unlinkAccountSchema } from "@/modules/hr/hr.schemas";

/** Phase 3A M3a — teacher profiles (H14) and login-account links (H2, Q2). Synthetic values only. */
function ctxFor(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: `u-${roleKey}`, username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

const base = {
  employeeId: "e1",
  version: null,
  qualifications: [{ degree: " M.Sc. ", subject: "Physics", institution: "", year: "2010" }],
  professionalQualifications: [{ name: "B.Ed", year: "" }],
  specializations: ["Physics", "Mathematics"],
  experienceYearsBefore: "5",
  teacherRegistrationNo: "",
};

describe("teacher profile schema (H14)", () => {
  it("normalizes entries: trimmed text, blank optional fields → null, years and experience as numbers", () => {
    expect(teacherProfileSchema.parse(base)).toEqual({
      employeeId: "e1",
      version: null,
      qualifications: [{ degree: "M.Sc.", subject: "Physics", institution: null, year: 2010 }],
      professionalQualifications: [{ name: "B.Ed", year: null }],
      specializations: ["Physics", "Mathematics"],
      experienceYearsBefore: 5,
      teacherRegistrationNo: null,
    });
    expect(teacherProfileSchema.parse({ ...base, experienceYearsBefore: "", version: "3" })).toMatchObject({ experienceYearsBefore: 0, version: 3 });
  });

  it("at most 10 × 60 characters of specializations, each once (case-insensitive)", () => {
    expect(teacherProfileSchema.safeParse({ ...base, specializations: Array.from({ length: 10 }, (_, i) => `Subject ${i}`) }).success).toBe(true);
    expect(teacherProfileSchema.safeParse({ ...base, specializations: Array.from({ length: 11 }, (_, i) => `Subject ${i}`) }).success).toBe(false);
    expect(teacherProfileSchema.safeParse({ ...base, specializations: ["x".repeat(61)] }).success).toBe(false);
    expect(teacherProfileSchema.safeParse({ ...base, specializations: ["Physics", "physics"] }).success).toBe(false);
    expect(teacherProfileSchema.safeParse({ ...base, specializations: ["गणित", "Khasi"] }).success).toBe(true); // any language
  });

  it("at most 10 qualifications of each kind; a degree / name is required in every entry", () => {
    const q = { degree: "B.A.", subject: "", institution: "", year: "" };
    expect(teacherProfileSchema.safeParse({ ...base, qualifications: Array(10).fill(q) }).success).toBe(true);
    expect(teacherProfileSchema.safeParse({ ...base, qualifications: Array(11).fill(q) }).success).toBe(false);
    expect(teacherProfileSchema.safeParse({ ...base, qualifications: [{ ...q, degree: " " }] }).success).toBe(false);
    expect(teacherProfileSchema.safeParse({ ...base, professionalQualifications: Array(11).fill({ name: "CTET", year: "" }) }).success).toBe(false);
  });

  it("refuses impossible years and experience, control characters and unknown fields (strict)", () => {
    for (const over of [
      { qualifications: [{ degree: "B.A.", subject: "", institution: "", year: "1949" }] },
      { qualifications: [{ degree: "B.A.", subject: "", institution: "", year: "20x0" }] },
      { experienceYearsBefore: "61" },
      { experienceYearsBefore: "2.5" },
      { teacherRegistrationNo: "AB\u0007C" },
      { employeeCode: "EMP-2026-0001" },
      { staffType: "TEACHING" },
    ]) {
      expect(teacherProfileSchema.safeParse({ ...base, ...over }).success, JSON.stringify(over)).toBe(false);
    }
    expect(teacherProfileSchema.safeParse({ ...base, qualifications: [{ degree: "B.A.", subject: "", institution: "", year: "2010", grade: "A" }] }).success).toBe(false);
  });
});

describe("login-account links (H2, Q2)", () => {
  it("link and unlink inputs are strict", () => {
    expect(linkAccountSchema.parse({ employeeId: "e1", userId: "u1" })).toEqual({ employeeId: "e1", userId: "u1" });
    expect(linkAccountSchema.safeParse({ employeeId: "e1", userId: "u1", roleKeys: ["SUPER_ADMIN"] }).success).toBe(false);
    expect(unlinkAccountSchema.safeParse({ employeeId: "e1", userId: "u1" }).success).toBe(false);
  });

  it("only roles holding employee.manage AND user.manage may link — Super Admin by default; HR Manager can't (Q2), nor School Admin (no user.manage)", async () => {
    const { canLinkAccounts } = await import("@/modules/hr/staff-accounts.service");
    expect(ROLES.map((r) => r.key).filter((k) => canLinkAccounts(ctxFor(k)))).toEqual(["SUPER_ADMIN"]);
  });

  it("the service refuses before any database access when either permission is missing", async () => {
    const { linkStaffAccount, unlinkStaffAccount } = await import("@/modules/hr/staff-accounts.service");
    for (const role of ["HR_MANAGER", "SCHOOL_ADMIN", "LIBRARIAN", "TEACHER"]) {
      await expect(linkStaffAccount(ctxFor(role), { employeeId: "e1", userId: "u1" }), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(unlinkStaffAccount(ctxFor(role), "e1"), role).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("teacher profiles: writes need employee.manage (refused before any database access)", async () => {
    const { saveTeacherProfile } = await import("@/modules/hr/teacher-profiles.service");
    for (const role of ["LIBRARIAN", "PRINCIPAL", "TEACHER", "ACCOUNTANT"]) {
      await expect(saveTeacherProfile(ctxFor(role), teacherProfileSchema.parse(base)), role).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
