import { describe, expect, it } from "vitest";
import { classifyRange } from "@/modules/hr/leave.rules";
import { nextClassFor, targetClass, type ClassOption } from "@/modules/academic/promotion.rules";
import { correctionRule, summarizeStudentDays, type StudentStatus } from "@/modules/academic/student-attendance.rules";

/** Phase 4A student-attendance rules and 4C promotion rules (PHASE_4_PLAN.md AC6, AC7, AC16). */
describe("summarizeStudentDays", () => {
  // November 2026 with Sundays and the 2nd / 4th Saturdays off for students; a students-only holiday on the 12th.
  const days = classifyRange("2026-11-01", "2026-11-30", { days: [0], saturdays: [2, 4] }, new Set(["2026-11-12"]));
  it("counts school days to today, ½ for half days, EXCUSED as not attended, unmarked outside the denominator", () => {
    const marks = new Map<string, StudentStatus>([
      ["2026-11-02", "PRESENT"],
      ["2026-11-03", "LATE"],
      ["2026-11-04", "HALF_DAY"],
      ["2026-11-05", "ABSENT"],
      ["2026-11-06", "EXCUSED"],
      ["2026-11-07", "PRESENT"],
    ]);
    const s = summarizeStudentDays(days, marks, () => true, "2026-11-10");
    // School days 2–7, 9, 10 (Sunday 8 off; 7th is the 1st Saturday → open) = 8.
    expect(s).toEqual({ schoolDays: 8, marked: 6, unmarked: 2, present: 2, late: 1, halfDay: 1, absent: 1, excused: 1, percent: "58.33" });
  });
  it("skips the student weekly off, holidays and days before enrollment; no marks → no percent", () => {
    const s = summarizeStudentDays(days, new Map(), (d) => d >= "2026-11-13", "2026-11-16");
    // 13, 16 (14th = 2nd Saturday off, 15 Sunday) = 2.
    expect([s.schoolDays, s.unmarked, s.percent]).toEqual([2, 2, null]);
  });
});

describe("correctionRule (AC7)", () => {
  const base = { date: "2026-11-10", today: "2026-11-10", hasSavedMark: true, isClassTeacher: true, canManage: false };
  it("class teacher: first marks any past day; changes only on the same day", () => {
    expect(correctionRule({ ...base, hasSavedMark: false, date: "2026-11-03" })).toEqual({ allowed: true, reasonRequired: false });
    expect(correctionRule(base)).toEqual({ allowed: true, reasonRequired: false });
    expect(correctionRule({ ...base, date: "2026-11-09" })).toEqual({ allowed: false, reasonRequired: false });
  });
  it("academic.manage: changes any past day with a reason; nobody marks the future", () => {
    expect(correctionRule({ ...base, date: "2026-11-01", isClassTeacher: false, canManage: true })).toEqual({ allowed: true, reasonRequired: true });
    expect(correctionRule({ ...base, date: "2026-11-11", canManage: true })).toEqual({ allowed: false, reasonRequired: false });
    expect(correctionRule({ ...base, isClassTeacher: false })).toEqual({ allowed: false, reasonRequired: false });
  });
});

describe("promotion rules (AC16)", () => {
  const c = (id: string, numericLevel: number, displayOrder = 0, isActive = true): ClassOption => ({ id, name: id, numericLevel, displayOrder, isActive });
  const classes = [c("UKG", 0), c("C1", 1), c("C10", 10), c("C11-SCI", 11, 1), c("C11-COM", 11, 2), c("C11-OLD", 11, 0, false), c("C12", 12), c("C5", 5)];
  it("one class at the next level → promote there; pre-primary moves into Class 1", () => {
    expect(nextClassFor(classes, c("UKG", 0))).toEqual({ kind: "one", classId: "C1" });
  });
  it("streams → the user must choose (inactive classes never offered)", () => {
    expect(nextClassFor(classes, c("C10", 10))).toEqual({ kind: "choose", classIds: ["C11-SCI", "C11-COM"] });
    expect(targetClass(classes, c("C10", 10), "PROMOTE", null)).toEqual({ ok: false, reason: "choose_class" });
    expect(targetClass(classes, c("C10", 10), "PROMOTE", "C11-COM")).toEqual({ ok: true, classId: "C11-COM" });
    expect(targetClass(classes, c("C10", 10), "PROMOTE", "C11-OLD")).toEqual({ ok: false, reason: "invalid_choice" });
  });
  it("class 12 completes school; a missing next level is reported, not guessed", () => {
    expect(nextClassFor(classes, c("C12", 12))).toEqual({ kind: "completes" });
    expect(nextClassFor(classes, c("C1", 1))).toEqual({ kind: "none_configured", level: 2 });
    expect(targetClass(classes, c("C1", 1), "PROMOTE", null)).toEqual({ ok: false, reason: "no_next_class" });
  });
  it("detain keeps the class (if still active); leave has no next class", () => {
    expect(targetClass(classes, c("C5", 5), "DETAIN", null)).toEqual({ ok: true, classId: "C5" });
    expect(targetClass(classes, c("C11-OLD", 11, 0, false), "DETAIN", null)).toEqual({ ok: false, reason: "class_inactive" });
    expect(targetClass(classes, c("C5", 5), "LEAVE", null)).toEqual({ ok: true, classId: null });
  });
});
