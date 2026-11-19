import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { markStudentDaySchema } from "@/modules/students/student-attendance.schemas";
import { getStudentDay, getStudentMonth, markStudentDay, studentAttendanceAccess } from "@/modules/students/student-attendance.service";

/** Phase 4A-M4 student attendance — inputs and the access decision over every role (no database). */
function roleCtx(roleKey: string, userId = "u"): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId, username: userId, displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("mark inputs", () => {
  const base = { sectionId: "s", date: "2026-11-02", reason: "", entries: [{ enrollmentId: "e1", status: "PRESENT", version: null }] };
  it("five statuses only; unique students; 1–200; reasons ≥ 3 characters when given", () => {
    expect(markStudentDaySchema.safeParse(base).success).toBe(true);
    expect(markStudentDaySchema.safeParse({ ...base, entries: [{ enrollmentId: "e1", status: "ON_LEAVE", version: null }] }).success).toBe(false);
    expect(markStudentDaySchema.safeParse({ ...base, entries: [base.entries[0], base.entries[0]] }).success).toBe(false);
    expect(markStudentDaySchema.safeParse({ ...base, entries: [] }).success).toBe(false);
    expect(markStudentDaySchema.safeParse({ ...base, reason: "ok" }).success).toBe(false);
    expect(markStudentDaySchema.safeParse({ ...base, date: "2026-13-01" }).success).toBe(false);
  });
});

describe("studentAttendanceAccess (every role)", () => {
  const own = { classTeacherId: "u", sessionStatus: "ACTIVE" };
  const other = { classTeacherId: "someone-else", sessionStatus: "ACTIVE" };
  it("class teacher marks only their own section, and not once the session is closed", () => {
    for (const key of ["TEACHER", "CLASS_TEACHER"]) {
      expect(studentAttendanceAccess(roleCtx(key), own), key).toEqual({ isClassTeacher: true, canManage: false, canRead: true });
      expect(studentAttendanceAccess(roleCtx(key), other), key).toEqual({ isClassTeacher: false, canManage: false, canRead: false });
      expect(studentAttendanceAccess(roleCtx(key), { classTeacherId: "u", sessionStatus: "CLOSED" }).isClassTeacher, key).toBe(false);
    }
  });
  it("School Admin manages (first marks and later corrections), Principal / Vice Principal read only, Super Admin marks anywhere", () => {
    expect(studentAttendanceAccess(roleCtx("SCHOOL_ADMIN"), other)).toEqual({ isClassTeacher: false, canManage: true, canRead: true });
    for (const key of ["PRINCIPAL", "VICE_PRINCIPAL"]) expect(studentAttendanceAccess(roleCtx(key), other), key).toEqual({ isClassTeacher: false, canManage: false, canRead: true });
    expect(studentAttendanceAccess(roleCtx("SUPER_ADMIN"), other)).toEqual({ isClassTeacher: true, canManage: true, canRead: true });
  });
  it("staff without student-attendance permissions, parents and students get nothing here", () => {
    for (const key of ["ACCOUNTANT", "HR_MANAGER", "ADMISSION_OFFICER", "TRANSPORT_MANAGER", "LIBRARIAN"]) {
      expect(studentAttendanceAccess(roleCtx(key), own), key).toEqual({ isClassTeacher: false, canManage: false, canRead: false });
    }
  });
  it("roles without any student-attendance or academic.manage permission are refused before the database", async () => {
    for (const r of ROLES) {
      const ctx = roleCtx(r.key);
      const any = r.key === "SUPER_ADMIN" || ["attendance.student.read", "attendance.student.mark", "academic.manage"].some((k) => ctx.permissions.has(k as never));
      if (any) continue;
      await expect(getStudentDay(ctx, { sectionId: "s", date: "2026-11-02" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getStudentMonth(ctx, { sectionId: "s", month: "2026-11" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markStudentDay(ctx, { sectionId: "s", date: "2026-11-02", reason: "", entries: [{ enrollmentId: "e", status: "PRESENT", version: null }] }), r.key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
