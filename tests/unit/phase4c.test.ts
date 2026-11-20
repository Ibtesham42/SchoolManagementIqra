import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { calendarMonthSchema, createEventSchema } from "@/modules/academic/calendar.schemas";
import { calendarAccess, createEvent, deleteEvent, getCalendarMonth, updateEvent } from "@/modules/academic/calendar.service";
import { createHomeworkSchema } from "@/modules/academic/homework.schemas";
import { createHomework, homeworkAccess, listHomeworkSections, removeHomework, updateHomework } from "@/modules/academic/homework.service";
import { confirmTimingProblem, decisionProblem, targetSessionProblem, type ClassOption } from "@/modules/academic/promotion.rules";
import { confirmPromotionsSchema, proposePromotionsSchema } from "@/modules/students/promotion.schemas";
import { confirmPromotions, listPromotionSections, promotionAccess, proposePromotions } from "@/modules/students/promotion.service";

/** Phase 4C: promotion rules, homework / calendar / promotion schemas, and role gates over every role. */
function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows) };
}
const ALL_ROLES = ROLES.map((r) => r.key);
const cls = (id: string, numericLevel: number, isActive = true, displayOrder = numericLevel): ClassOption => ({ id, name: id, numericLevel, displayOrder, isActive });

describe("promotion rules (AC16)", () => {
  const classes = [cls("c8", 8), cls("c9", 9), cls("c11s", 11, true, 1), cls("c11c", 11, true, 2), cls("c10", 10), cls("c12", 12)];
  it("promote to the next level; streams need a choice; detain keeps the class; leave needs a reason", () => {
    expect(decisionProblem(classes, cls("c8", 8), { decision: "PROMOTE", toClassId: null, leaveAs: null })).toEqual({ ok: true, classId: "c9" });
    expect(decisionProblem(classes, cls("c10", 10), { decision: "PROMOTE", toClassId: null, leaveAs: null })).toMatchObject({ ok: false, message: expect.stringMatching(/stream/) });
    expect(decisionProblem(classes, cls("c10", 10), { decision: "PROMOTE", toClassId: "c11c", leaveAs: null })).toEqual({ ok: true, classId: "c11c" });
    expect(decisionProblem(classes, cls("c10", 10), { decision: "PROMOTE", toClassId: "c9", leaveAs: null })).toMatchObject({ ok: false });
    expect(decisionProblem(classes, cls("c8", 8), { decision: "DETAIN", toClassId: "c9", leaveAs: null })).toEqual({ ok: true, classId: "c8" });
    expect(decisionProblem(classes, cls("c8", 8, false), { decision: "DETAIN", toClassId: null, leaveAs: null })).toMatchObject({ ok: false, message: expect.stringMatching(/inactive/) });
    expect(decisionProblem(classes, cls("c12", 12), { decision: "PROMOTE", toClassId: null, leaveAs: null })).toMatchObject({ ok: false, message: expect.stringMatching(/highest class/) });
    expect(decisionProblem(classes, cls("c12", 12), { decision: "LEAVE", toClassId: null, leaveAs: null })).toMatchObject({ ok: false });
    expect(decisionProblem(classes, cls("c12", 12), { decision: "LEAVE", toClassId: null, leaveAs: "GRADUATED" })).toEqual({ ok: true, classId: null });
    expect(decisionProblem(classes, cls("c8", 8), { decision: "PROMOTE", toClassId: null, leaveAs: "WITHDRAWN" })).toMatchObject({ ok: false });
    expect(decisionProblem([cls("c8", 8)], cls("c8", 8), { decision: "PROMOTE", toClassId: null, leaveAs: null })).toMatchObject({ ok: false, message: expect.stringMatching(/Create it first/) });
  });
  it("confirmation only from the session's last day; the next session starts later and is open", () => {
    expect(confirmTimingProblem("2027-03-30", "2027-03-31")).toMatch(/last day/);
    expect(confirmTimingProblem("2027-03-31", "2027-03-31")).toBeNull();
    expect(targetSessionProblem({ endDate: "2027-03-31" }, { startDate: "2027-04-01", status: "PLANNED" })).toBeNull();
    expect(targetSessionProblem({ endDate: "2027-03-31" }, { startDate: "2027-03-31", status: "PLANNED" })).toMatch(/starts after/);
    expect(targetSessionProblem({ endDate: "2027-03-31" }, { startDate: "2027-04-01", status: "CLOSED" })).toMatch(/closed/);
  });
  it("schemas: strict, blank class / leave reason become null, duplicates refused", () => {
    const row = { enrollmentId: "e", decision: "PROMOTE", toClassId: "", leaveAs: "", version: null };
    expect(proposePromotionsSchema.parse({ sectionId: "s", entries: [row] }).entries[0]).toMatchObject({ toClassId: null, leaveAs: null });
    expect(proposePromotionsSchema.safeParse({ sectionId: "s", entries: [row, row] }).success).toBe(false);
    expect(proposePromotionsSchema.safeParse({ sectionId: "s", entries: [{ ...row, leaveAs: "ACTIVE" }] }).success).toBe(false);
    expect(confirmPromotionsSchema.safeParse({ sectionId: "s", targetSessionId: "t", targets: [{ classId: "c", sectionId: "a" }, { classId: "c", sectionId: "b" }] }).success).toBe(false);
  });
});

describe("homework and calendar schemas", () => {
  it("homework: trimmed title, multi-line details kept, control characters refused", () => {
    const h = createHomeworkSchema.parse({ sectionId: "s", classSubjectId: "c", title: "  Chapter   4  ", details: "Q1 to Q5\r\nRead pages 10–12  ", dueOn: "2026-12-01" });
    expect(h).toMatchObject({ title: "Chapter 4", details: "Q1 to Q5\nRead pages 10–12" });
    expect(createHomeworkSchema.safeParse({ sectionId: "s", classSubjectId: "c", title: "x\u0007", details: "d", dueOn: "2026-12-01" }).success).toBe(false);
    expect(createHomeworkSchema.safeParse({ sectionId: "s", classSubjectId: "c", title: "x", details: "   ", dueOn: "2026-12-01" }).success).toBe(false);
  });
  it("events: end date optional and in order; month format", () => {
    expect(createEventSchema.parse({ academicSessionId: "s", title: "Sports day", startDate: "2026-12-05", endDate: "", details: "" })).toMatchObject({ endDate: null, details: null });
    expect(createEventSchema.safeParse({ academicSessionId: "s", title: "X", startDate: "2026-12-05", endDate: "2026-12-04", details: "" }).success).toBe(false);
    expect(calendarMonthSchema.safeParse({ academicSessionId: "s", month: "2026-13" }).success).toBe(false);
  });
});

describe("Phase 4C role gates (every role)", () => {
  it("homework: homework.manage holders post (Teacher / Class Teacher ASSIGNED, School Admin ALL); others refused before the database", async () => {
    const holders = new Set(["SUPER_ADMIN", "SCHOOL_ADMIN", "TEACHER", "CLASS_TEACHER"]);
    const input = createHomeworkSchema.parse({ sectionId: "s", classSubjectId: "c", title: "T", details: "D", dueOn: "2026-12-01" });
    for (const key of ALL_ROLES) {
      const ctx = roleCtx(key);
      expect(homeworkAccess(ctx).manage, key).toBe(holders.has(key));
      if (holders.has(key)) continue;
      await expect(createHomework(ctx, input), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateHomework(ctx, { id: "h", version: 1, title: "T", details: "D", dueOn: "2026-12-01" }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeHomework(ctx, { id: "h", version: 1 }), key).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const key of ["PARENT", "STUDENT"]) await expect(listHomeworkSections(roleCtx(key), "s"), key).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("calendar: events need academic.manage; parents and students can't read it here", async () => {
    for (const key of ALL_ROLES) {
      const ctx = roleCtx(key);
      if (calendarAccess(ctx).manage) continue;
      await expect(createEvent(ctx, createEventSchema.parse({ academicSessionId: "s", title: "X", startDate: "2026-12-05", endDate: "", details: "" })), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateEvent(ctx, { id: "e", version: 1, title: "X", startDate: "2026-12-05", endDate: null, details: null }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteEvent(ctx, { id: "e", version: 1 }), key).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(calendarAccess(roleCtx("TEACHER")).read).toBe(true);
    expect(calendarAccess(roleCtx("ACCOUNTANT")).manage).toBe(false);
    // Parent / Student hold timetable.read at CHILDREN / SELF only: no calendar until the portal (AC20).
    for (const key of ["PARENT", "STUDENT"]) {
      expect(calendarAccess(roleCtx(key)).read, key).toBe(false);
      await expect(getCalendarMonth(roleCtx(key), { academicSessionId: "s", month: "2026-12" }), key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("promotion: confirm only with student.promote; propose also by the class teacher of the own open section", async () => {
    const own = { classTeacherId: "u", sessionStatus: "ACTIVE" };
    for (const key of ALL_ROLES) {
      const ctx = roleCtx(key);
      const confirm = ctx.permissions.has("student.promote") || key === "SUPER_ADMIN";
      expect(promotionAccess(ctx, { classTeacherId: "other", sessionStatus: "ACTIVE" }).confirm, key).toBe(ctx.permissions.has("student.promote"));
      if (!confirm) await expect(confirmPromotions(ctx, { sectionId: "s", targetSessionId: "t", targets: [] }), key).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(promotionAccess(roleCtx("CLASS_TEACHER"), own)).toEqual({ propose: true, confirm: false });
    expect(promotionAccess(roleCtx("CLASS_TEACHER"), { ...own, classTeacherId: "other" })).toEqual({ propose: false, confirm: false });
    expect(promotionAccess(roleCtx("CLASS_TEACHER"), { ...own, sessionStatus: "CLOSED" })).toEqual({ propose: false, confirm: false });
    expect(promotionAccess(roleCtx("SCHOOL_ADMIN"), { ...own, classTeacherId: "other" })).toEqual({ propose: true, confirm: true });
    for (const key of ["PARENT", "STUDENT", "ACCOUNTANT"]) {
      await expect(listPromotionSections(roleCtx(key), "s"), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(proposePromotions(roleCtx(key), { sectionId: "s", entries: [{ enrollmentId: "e", decision: "DETAIN", toClassId: null, leaveAs: null, version: null }] }), key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
