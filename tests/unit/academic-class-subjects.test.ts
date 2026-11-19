import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { addClassSubjectsSchema, copyClassSubjectsSchema, updateClassSubjectSchema } from "@/modules/academic/class-subjects.schemas";
import { addClassSubjects, copyClassSubjects, listClassSubjects, removeClassSubject, updateClassSubject } from "@/modules/academic/class-subjects.service";

/** Phase 4A-M2 class subjects — input rules and permission gates over every role (refused before any database access). */
function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("class-subject schemas", () => {
  it("add: 1–30 unique subjects; optional from a checkbox", () => {
    const base = { academicSessionId: "s", classId: "c", subjectIds: ["a", "b"], isOptional: "on" };
    expect(addClassSubjectsSchema.parse(base).isOptional).toBe(true);
    expect(addClassSubjectsSchema.parse({ ...base, isOptional: "" }).isOptional).toBe(false);
    expect(addClassSubjectsSchema.safeParse({ ...base, subjectIds: [] }).success).toBe(false);
    expect(addClassSubjectsSchema.safeParse({ ...base, subjectIds: ["a", "a"] }).success).toBe(false);
    expect(addClassSubjectsSchema.safeParse({ ...base, subjectIds: Array.from({ length: 31 }, (_, i) => `s${i}`) }).success).toBe(false);
  });
  it("update: order 0–999 whole numbers; copy needs two different sessions", () => {
    expect(updateClassSubjectSchema.parse({ id: "x", version: "2", isOptional: "", sortOrder: "5" })).toEqual({ id: "x", version: 2, isOptional: false, sortOrder: 5 });
    expect(updateClassSubjectSchema.safeParse({ id: "x", version: "2", isOptional: "", sortOrder: "1000" }).success).toBe(false);
    expect(updateClassSubjectSchema.safeParse({ id: "x", version: "2", isOptional: "", sortOrder: "1.5" }).success).toBe(false);
    expect(copyClassSubjectsSchema.safeParse({ fromSessionId: "a", toSessionId: "a" }).success).toBe(false);
  });
});

describe("class-subject permission gates (every role)", () => {
  it("writes need academic.manage; reads need academic.read at ALL (class teachers at ASSIGNED are refused)", async () => {
    for (const r of ROLES) {
      const ctx = roleCtx(r.key);
      const manage = r.key === "SUPER_ADMIN" || ctx.permissions.has("academic.manage");
      const readAll = r.key === "SUPER_ADMIN" || ctx.permissions.get("academic.read")?.has("ALL") === true;
      if (!manage) {
        await expect(addClassSubjects(ctx, { academicSessionId: "s", classId: "c", subjectIds: ["a"], isOptional: false }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(updateClassSubject(ctx, { id: "x", version: 1, isOptional: false, sortOrder: 0 }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(removeClassSubject(ctx, { id: "x", version: 1 }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(copyClassSubjects(ctx, { fromSessionId: "a", toSessionId: "b" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!readAll) await expect(listClassSubjects(ctx, { academicSessionId: "s", classId: "c" }), r.key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
