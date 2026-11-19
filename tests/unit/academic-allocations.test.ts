import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { assignTeacherSchema } from "@/modules/academic/allocations.schemas";
import { assignTeacher, listAllocatableTeachers, listSectionAllocations, removeAllocation } from "@/modules/academic/allocations.service";
import { ALLOCATABLE_TEACHER_EMPLOYEE } from "@/modules/hr/hr.tx";

/** Phase 4A-M2 teacher allocation — inputs, eligibility filter and permission gates over every role. */
function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("allocation inputs and eligibility (AC4)", () => {
  it("version is null for a first allocation, a number when changing one", () => {
    expect(assignTeacherSchema.parse({ sectionId: "s", classSubjectId: "c", employeeId: "e", version: null }).version).toBeNull();
    expect(assignTeacherSchema.parse({ sectionId: "s", classSubjectId: "c", employeeId: "e", version: "3" }).version).toBe(3);
    expect(assignTeacherSchema.safeParse({ sectionId: "s", classSubjectId: "c", employeeId: "", version: null }).success).toBe(false);
    expect(assignTeacherSchema.safeParse({ sectionId: "s", classSubjectId: "c", employeeId: "e", version: null, userId: "u" }).success).toBe(false);
  });
  it("teachers = ACTIVE, TEACHING, not deleted, with an active, not deleted linked login", () => {
    expect(ALLOCATABLE_TEACHER_EMPLOYEE).toEqual({
      employmentStatus: "ACTIVE",
      staffType: "TEACHING",
      deletedAt: null,
      user: { is: { isActive: true, deletedAt: null } },
    });
  });
});

describe("allocation permission gates (every role)", () => {
  it("writes and the teacher picker need academic.manage; reads need academic.read at ALL", async () => {
    for (const r of ROLES) {
      const ctx = roleCtx(r.key);
      if (r.key !== "SUPER_ADMIN" && !ctx.permissions.has("academic.manage")) {
        await expect(assignTeacher(ctx, { sectionId: "s", classSubjectId: "c", employeeId: "e", version: null }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(removeAllocation(ctx, { id: "x", version: 1 }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(listAllocatableTeachers(ctx), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (r.key !== "SUPER_ADMIN" && ctx.permissions.get("academic.read")?.has("ALL") !== true) {
        await expect(listSectionAllocations(ctx, { sectionId: "s" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
  });
});
