import { describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { createScaleSchema } from "@/modules/academic/grading.schemas";
import { createCbseStyleScale, createScale, gradingAccess, listScales, setScaleActive, updateScale } from "@/modules/academic/grading.service";

/** Phase 4B-M2 grading scales: input parsing, band validation before any database access, and role gates. */
function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows) };
}
const band = (minPercent: string, grade: string, gradePoint = "", remark = "") => ({ minPercent, grade, gradePoint, remark });

describe("grading scale schema", () => {
  it("parses bands: blank grade point and remark become null; remark whitespace collapsed", () => {
    const r = createScaleSchema.parse({ name: "Primary", bands: [band("0", "C"), band("50", "B", "8.5", "  Very   good ")] });
    expect(r.bands[0]).toEqual({ minPercent: "0", grade: "C", gradePoint: null, remark: null });
    expect(r.bands[1]).toEqual({ minPercent: "50", grade: "B", gradePoint: "8.5", remark: "Very good" });
  });
  it("rejects bad percentages, grade points, long grades, control characters, too few bands and unknown keys", () => {
    for (const bands of [
      [band("0", "C"), band("50.555", "B")],
      [band("0", "C"), band("abc", "B")],
      [band("0", "C"), band("50", "B", "100")],
      [band("0", "C"), band("50", "TOOLONG")],
      [band("0", "C"), band("50", "B\u0007")],
      [band("0", "C")],
    ]) {
      expect(createScaleSchema.safeParse({ name: "X", bands }).success, JSON.stringify(bands)).toBe(false);
    }
    expect(createScaleSchema.safeParse({ name: "X", bands: [band("0", "C"), band("50", "B")], extra: 1 }).success).toBe(false);
  });
});

describe("grading scale service gates", () => {
  const admin = roleCtx("SCHOOL_ADMIN");
  it("structurally invalid bands are refused as validation errors before any database access", async () => {
    const input = createScaleSchema.parse({ name: "Bad", bands: [band("10", "C"), band("50", "B")] }); // must start at 0
    await expect(createScale(admin, input)).rejects.toBeInstanceOf(ValidationError);
    const dup = createScaleSchema.parse({ name: "Dup", bands: [band("0", "C"), band("0", "B")] });
    await expect(createScale(admin, dup)).rejects.toBeInstanceOf(ValidationError);
  });
  it("only exam.manage holders change scales; teachers, parents and students are refused", async () => {
    const input = createScaleSchema.parse({ name: "X", bands: [band("0", "C"), band("50", "B")] });
    for (const key of ["TEACHER", "CLASS_TEACHER", "ACCOUNTANT", "PARENT", "STUDENT"]) {
      const ctx = roleCtx(key);
      await expect(createScale(ctx, input), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createCbseStyleScale(ctx), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateScale(ctx, { id: "x", version: 1, ...input }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setScaleActive(ctx, { id: "x", version: 1, active: false }), key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("reading needs exam.manage or school-wide academic.read; parents and students see nothing", async () => {
    expect(gradingAccess(roleCtx("SCHOOL_ADMIN"))).toEqual({ manage: true, read: true });
    expect(gradingAccess(roleCtx("PRINCIPAL")).manage).toBe(true);
    for (const key of ["PARENT", "STUDENT"]) {
      expect(gradingAccess(roleCtx(key)), key).toEqual({ manage: false, read: false });
      await expect(listScales(roleCtx(key)), key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
