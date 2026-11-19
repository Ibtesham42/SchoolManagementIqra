import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { setSubjectChoicesSchema } from "@/modules/students/subject-choices.schemas";
import { getSectionChoices, setSubjectChoices } from "@/modules/students/subject-choices.service";

/** Phase 4A-M2 optional subjects per student — inputs and permission gates over every role (no database). */
function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("choice inputs", () => {
  const base = { sectionId: "s", classSubjectId: "c", enrollmentIds: ["a", "b"], expectedIds: [] };
  it("an empty list clears the subject; duplicates and extra fields are refused", () => {
    expect(setSubjectChoicesSchema.safeParse({ ...base, enrollmentIds: [] }).success).toBe(true);
    expect(setSubjectChoicesSchema.safeParse({ ...base, enrollmentIds: ["a", "a"] }).success).toBe(false);
    expect(setSubjectChoicesSchema.safeParse({ ...base, studentIds: ["a"] }).success).toBe(false);
    expect(setSubjectChoicesSchema.safeParse({ sectionId: "s", classSubjectId: "c", enrollmentIds: [] }).success).toBe(false); // expectedIds required
  });
});

describe("choice permission gates (every role)", () => {
  it("saving needs academic.manage; reading needs academic.read AND student.read at ALL", async () => {
    for (const r of ROLES) {
      const ctx = roleCtx(r.key);
      const sa = r.key === "SUPER_ADMIN";
      if (!sa && !ctx.permissions.has("academic.manage")) {
        await expect(setSubjectChoices(ctx, { sectionId: "s", classSubjectId: "c", enrollmentIds: [], expectedIds: [] }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      const readAll = (k: "academic.read" | "student.read") => sa || ctx.permissions.get(k)?.has("ALL") === true;
      if (!readAll("academic.read") || !readAll("student.read")) {
        await expect(getSectionChoices(ctx, { sectionId: "s" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
  });
  it("class teachers (ASSIGNED) can't read the school-wide choice screen yet (KI-077)", async () => {
    await expect(getSectionChoices(roleCtx("CLASS_TEACHER"), { sectionId: "s" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
