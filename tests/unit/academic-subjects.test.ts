import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { createSubjectSchema, setSubjectActiveSchema, updateSubjectSchema } from "@/modules/academic/subjects.schemas";
import { createSubject, listSubjects, setSubjectActive, updateSubject } from "@/modules/academic/subjects.service";

/** Phase 4A-M2 subjects — input rules and permission gates (refused before any database access). */
function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("subject schemas", () => {
  it("normalizes code to upper case and accepts names in any script", () => {
    expect(createSubjectSchema.parse({ code: " math ", name: "  Mathematics  ", kind: "SCHOLASTIC" })).toEqual({ code: "MATH", name: "Mathematics", kind: "SCHOLASTIC" });
    expect(createSubjectSchema.parse({ code: "HIN", name: "हिन्दी", kind: "SCHOLASTIC" }).name).toBe("हिन्दी");
    expect(createSubjectSchema.parse({ code: "ART-CRAFT", name: "Art  and   craft", kind: "CO_SCHOLASTIC" }).name).toBe("Art and craft");
  });
  it("refuses bad codes, empty names, unknown kinds and extra fields", () => {
    expect(createSubjectSchema.safeParse({ code: "MA TH", name: "Maths", kind: "SCHOLASTIC" }).success).toBe(false);
    expect(createSubjectSchema.safeParse({ code: "MATH", name: "   ", kind: "SCHOLASTIC" }).success).toBe(false);
    expect(createSubjectSchema.safeParse({ code: "MATH", name: "Maths", kind: "ELECTIVE" }).success).toBe(false);
    expect(createSubjectSchema.safeParse({ code: "MATH", name: "Maths", kind: "SCHOLASTIC", isActive: false }).success).toBe(false);
    expect(updateSubjectSchema.safeParse({ code: "MATH", name: "Maths", kind: "SCHOLASTIC" }).success).toBe(false); // id + version required
    expect(setSubjectActiveSchema.safeParse({ id: "x", version: "2", active: true }).success).toBe(true);
  });
});

describe("subject permission gates (every role)", () => {
  const input = { code: "MATH", name: "Mathematics", kind: "SCHOLASTIC" as const };
  it("only academic.manage holders write (School Admin, Super Admin); everyone else is refused before the database", async () => {
    const writers = ROLES.filter((r) => r.key === "SUPER_ADMIN" || roleCtx(r.key).permissions.has("academic.manage")).map((r) => r.key);
    expect(writers.sort()).toEqual(["SCHOOL_ADMIN", "SUPER_ADMIN"]);
    for (const r of ROLES.filter((x) => !writers.includes(x.key))) {
      await expect(createSubject(roleCtx(r.key), input), r.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateSubject(roleCtx(r.key), { id: "x", version: 1, ...input }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setSubjectActive(roleCtx(r.key), { id: "x", version: 1, active: false }), r.key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("reading needs academic.read (Parent, Student, Accountant, HR Manager … refused)", async () => {
    const nonReaders = ROLES.filter((r) => r.key !== "SUPER_ADMIN" && !roleCtx(r.key).permissions.has("academic.read")).map((r) => r.key);
    expect(nonReaders).toEqual(expect.arrayContaining(["PARENT", "STUDENT", "ACCOUNTANT", "HR_MANAGER"]));
    for (const key of nonReaders) await expect(listSubjects(roleCtx(key)), key).rejects.toBeInstanceOf(ForbiddenError);
  });
});
