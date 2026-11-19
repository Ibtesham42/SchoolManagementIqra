import { describe, expect, it } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { copyDayPlanSchema, saveDayPlanSchema, setSlotSchema } from "@/modules/academic/timetable.schemas";
import { copyDayPlan, dayFingerprint, getMyTimetable, getPeriodPlan, getSectionTimetable, saveDayPlan, setSlot } from "@/modules/academic/timetable.service";

/** Phase 4A-M3 timetable — inputs, the stale-screen fingerprint and permission gates over every role (no database). */
function roleCtx(roleKey: string, extra: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), ...extra };
}
const row = (startTime: string, endTime: string, kind = "TEACHING", label = "") => ({ startTime, endTime, kind, label });

describe("timetable inputs", () => {
  it("a day's plan: up to 15 periods, HH:MM, end after start, optional label", () => {
    const ok = saveDayPlanSchema.parse({ academicSessionId: "s", dayOfWeek: "1", fingerprint: "", periods: [row("08:00", "08:40", "TEACHING", "  Maths  "), row("08:40", "09:00", "BREAK")] });
    expect(ok.dayOfWeek).toBe(1);
    expect(ok.periods.map((p) => p.label)).toEqual(["Maths", null]);
    expect(saveDayPlanSchema.safeParse({ academicSessionId: "s", dayOfWeek: "7", fingerprint: "", periods: [] }).success).toBe(false);
    expect(saveDayPlanSchema.safeParse({ academicSessionId: "s", dayOfWeek: "1", fingerprint: "", periods: [row("09:00", "08:00")] }).success).toBe(false);
    expect(saveDayPlanSchema.safeParse({ academicSessionId: "s", dayOfWeek: "1", fingerprint: "", periods: [row("8:00", "08:40")] }).success).toBe(false);
    expect(saveDayPlanSchema.safeParse({ academicSessionId: "s", dayOfWeek: "1", fingerprint: "", periods: Array.from({ length: 16 }, () => row("08:00", "08:40")) }).success).toBe(false);
  });
  it("copy: other days only, unique; a slot can be cleared with null", () => {
    expect(copyDayPlanSchema.safeParse({ academicSessionId: "s", fromDay: "1", toDays: ["1", "2"], fingerprints: {} }).success).toBe(false);
    expect(copyDayPlanSchema.safeParse({ academicSessionId: "s", fromDay: "1", toDays: ["2", "2"], fingerprints: {} }).success).toBe(false);
    expect(copyDayPlanSchema.parse({ academicSessionId: "s", fromDay: "1", toDays: ["2", "3"], fingerprints: {} }).toDays).toEqual([2, 3]);
    expect(setSlotSchema.parse({ sectionId: "s", periodId: "p", classSubjectId: null, version: "2" })).toEqual({ sectionId: "s", periodId: "p", classSubjectId: null, version: 2 });
  });
  it("the day fingerprint changes when any period is added, removed or edited", () => {
    expect(dayFingerprint([])).toBe("");
    expect(dayFingerprint([{ id: "a", version: 1 }, { id: "b", version: 2 }])).toBe("a:1,b:2");
    expect(dayFingerprint([{ id: "a", version: 2 }])).not.toBe(dayFingerprint([{ id: "a", version: 1 }]));
  });
  it("overlapping periods are refused before any database access", async () => {
    await expect(
      saveDayPlan(roleCtx("SUPER_ADMIN"), { academicSessionId: "s", dayOfWeek: 1, fingerprint: "", periods: [
        { startTime: "08:00", endTime: "08:45", kind: "TEACHING", label: null },
        { startTime: "08:40", endTime: "09:20", kind: "TEACHING", label: null },
      ] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("timetable permission gates (every role)", () => {
  it("writes need timetable.manage; school-wide reads need timetable.read at ALL (Parent / Student refused)", async () => {
    for (const r of ROLES) {
      const ctx = roleCtx(r.key);
      const sa = r.key === "SUPER_ADMIN";
      if (!sa && !ctx.permissions.has("timetable.manage")) {
        await expect(saveDayPlan(ctx, { academicSessionId: "s", dayOfWeek: 1, fingerprint: "", periods: [] }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(copyDayPlan(ctx, { academicSessionId: "s", fromDay: 1, toDays: [2], fingerprints: {} }), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(setSlot(ctx, { sectionId: "s", periodId: "p", classSubjectId: null, version: null }), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!sa && ctx.permissions.get("timetable.read")?.has("ALL") !== true) {
        await expect(getPeriodPlan(ctx, "s"), r.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(getSectionTimetable(ctx, "s"), r.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
    for (const key of ["PARENT", "STUDENT"]) await expect(getSectionTimetable(roleCtx(key), "s"), key).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("only School Admin (and Super Admin) edit timetables; teachers read them", () => {
    expect(ROLES.filter((r) => roleCtx(r.key).permissions.has("timetable.manage")).map((r) => r.key)).toEqual(["SUPER_ADMIN", "SCHOOL_ADMIN"]);
    expect(roleCtx("TEACHER").permissions.get("timetable.read")?.has("ALL")).toBe(true);
  });
  it("My timetable without a linked staff record says so instead of failing", async () => {
    expect(await getMyTimetable(roleCtx("TEACHER"), "s")).toEqual({ linked: false });
  });
});
