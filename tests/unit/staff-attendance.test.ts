import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPermissionMap, authorize, type AuthContext } from "@/lib/rbac/authorize";
import { ROLES, normalizeGrant } from "@/lib/rbac/catalog";
import { classifyRange, NO_WEEKLY_OFF } from "@/modules/hr/leave.rules";
import {
  employedOn,
  monthBounds,
  planDay,
  shiftMonth,
  summarizeMonth,
  timeFromDb,
  timeToDb,
  type ExistingMark,
  type MarkEntry,
} from "@/modules/hr/staff-attendance.rules";
import { attendanceRegisterSchema, markDaySchema, markEntrySchema } from "@/modules/hr/staff-attendance.schemas";

function ctxFor(roleKey: string, extra: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map((g) => {
    const { key, scope } = normalizeGrant(g);
    return { roleKey, isSystem: !!role.isSystem, permissionKey: key, scope };
  });
  return {
    userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s",
    isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), ...extra,
  };
}

describe("times and months", () => {
  it("round-trips HH:MM through the time(0) representation", () => {
    expect(timeFromDb(timeToDb("09:05"))).toBe("09:05");
    expect(timeFromDb(null)).toBeNull();
  });
  it("month bounds handle leap years and December", () => {
    expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});

describe("employedOn", () => {
  const base = { joiningDate: "2026-06-10", leavingDate: null, employmentStatus: "ACTIVE" };
  it("starts on the joining date", () => {
    expect(employedOn(base, "2026-06-09")).toBe(false);
    expect(employedOn(base, "2026-06-10")).toBe(true);
  });
  it("ends after the leaving date; a leaver without one is gone (fail closed)", () => {
    const left = { ...base, leavingDate: "2026-09-30", employmentStatus: "RESIGNED" };
    expect(employedOn(left, "2026-09-30")).toBe(true);
    expect(employedOn(left, "2026-10-01")).toBe(false);
    expect(employedOn({ ...base, employmentStatus: "RETIRED" }, "2026-07-01")).toBe(false);
    expect(employedOn({ ...base, employmentStatus: "ON_LEAVE" }, "2026-07-01")).toBe(true);
  });
});

describe("planDay (L7/L8)", () => {
  const row = (o: Partial<ExistingMark> = {}): ExistingMark => ({
    id: "r1", employeeId: "e1", status: "PRESENT", checkIn: null, checkOut: null, leaveRequestId: null, version: 2, ...o,
  });
  const entry = (o: Partial<MarkEntry> = {}): MarkEntry => ({
    employeeId: "e1", status: "PRESENT", checkIn: null, checkOut: null, version: null, ...o,
  });

  it("creates unmarked rows without a reason", () => {
    const p = planDay([], [entry(), entry({ employeeId: "e2", status: "ABSENT" })], false);
    expect(p.create).toHaveLength(2);
    expect(p.problems).toEqual([]);
  });
  it("skips unchanged saved rows (no reason needed)", () => {
    const p = planDay([row()], [entry({ version: 2 })], false);
    expect(p).toMatchObject({ unchanged: 1, create: [], correct: [], problems: [] });
  });
  it("requires a reason to change a saved row", () => {
    expect(planDay([row()], [entry({ version: 2, status: "LATE" })], false).problems).toEqual([
      { kind: "reason_required", employeeId: "e1" },
    ]);
    const ok = planDay([row()], [entry({ version: 2, status: "LATE", checkIn: "09:40" })], true);
    expect(ok.correct).toHaveLength(1);
    expect(ok.correct[0]).toMatchObject({ id: "r1", version: 2, before: "PRESENT" });
  });
  it("a time change alone is a correction", () => {
    expect(planDay([row()], [entry({ version: 2, checkIn: "08:00" })], false).problems[0].kind).toBe("reason_required");
  });
  it("is stale on a version mismatch, on a row that appeared, or on one that vanished", () => {
    expect(planDay([row()], [entry({ version: 1 })], true).problems[0].kind).toBe("stale");
    expect(planDay([row()], [entry({ version: null })], true).problems[0].kind).toBe("stale");
    expect(planDay([], [entry({ version: 3 })], true).problems[0].kind).toBe("stale");
  });
  it("never touches leave-owned rows", () => {
    const leave = row({ status: "ON_LEAVE", leaveRequestId: "lr1" });
    expect(planDay([leave], [entry({ version: 2 })], true).problems[0].kind).toBe("on_leave");
  });
});

describe("summarizeMonth", () => {
  // November 2026: 1st is a Sunday. Weekly off: Sunday only; holiday on the 14th.
  const days = classifyRange("2026-11-01", "2026-11-30", { days: [0], saturdays: [] }, new Set(["2026-11-14"]));
  it("counts working days up to today on the rolls, by status", () => {
    const rows = new Map([
      ["2026-11-02", { status: "PRESENT", leaveRequestId: null }],
      ["2026-11-03", { status: "LATE", leaveRequestId: null }],
      ["2026-11-04", { status: "HALF_DAY", leaveRequestId: null }],
      ["2026-11-05", { status: "HALF_DAY", leaveRequestId: "lr" }],
      ["2026-11-06", { status: "ON_LEAVE", leaveRequestId: "lr" }],
      ["2026-11-07", { status: "ABSENT", leaveRequestId: null }],
    ]);
    const s = summarizeMonth(days, rows, () => true, "2026-11-10");
    // Working days 2–7, 9, 10 (Sunday 8 off) = 8.
    expect(s).toEqual({ workingDays: 8, present: 1, late: 1, halfDay: 1, onLeave: 1, halfDayLeave: 1, absent: 1, unmarked: 2 });
  });
  it("skips holidays, future days and days off the rolls", () => {
    const s = summarizeMonth(days, new Map(), (d) => d >= "2026-11-12", "2026-11-16");
    // 12, 13, 16 (14 holiday, 15 Sunday) = 3.
    expect(s.workingDays).toBe(3);
    expect(s.unmarked).toBe(3);
  });
  it("with no weekly off configured every non-holiday counts", () => {
    const all = classifyRange("2026-11-01", "2026-11-07", NO_WEEKLY_OFF, new Set());
    expect(summarizeMonth(all, new Map(), () => true, "2026-11-30").workingDays).toBe(7);
  });
});

describe("schemas", () => {
  const e = { employeeId: "e1", status: "PRESENT", checkIn: "", checkOut: "", version: null };
  it("accepts a blank-time entry and parses versions", () => {
    expect(markEntrySchema.parse(e)).toEqual({ ...e, checkIn: null, checkOut: null });
    expect(markEntrySchema.parse({ ...e, version: "3" }).version).toBe(3);
  });
  it("refuses manual ON_LEAVE / HOLIDAY, times on an absent day, check-out before check-in, bad times", () => {
    for (const status of ["ON_LEAVE", "HOLIDAY", "WEEKLY_OFF"]) expect(markEntrySchema.safeParse({ ...e, status }).success).toBe(false);
    expect(markEntrySchema.safeParse({ ...e, status: "ABSENT", checkIn: "09:00" }).success).toBe(false);
    expect(markEntrySchema.safeParse({ ...e, checkIn: "10:00", checkOut: "09:00" }).success).toBe(false);
    expect(markEntrySchema.safeParse({ ...e, checkIn: "24:00" }).success).toBe(false);
    expect(markEntrySchema.safeParse({ ...e, extra: 1 }).success).toBe(false);
  });
  it("day: unique employees, 1–500 entries, short reasons refused, control characters refused", () => {
    const day = { date: "2026-11-02", entries: [e], reason: "" };
    expect(markDaySchema.safeParse(day).success).toBe(true);
    expect(markDaySchema.safeParse({ ...day, entries: [e, e] }).success).toBe(false);
    expect(markDaySchema.safeParse({ ...day, entries: [] }).success).toBe(false);
    expect(markDaySchema.safeParse({ ...day, reason: "x" }).success).toBe(false);
    expect(markDaySchema.safeParse({ ...day, reason: "bad\u0007reason" }).success).toBe(false);
    expect(markDaySchema.safeParse({ ...day, date: "2026-02-30" }).success).toBe(false);
  });
  it("register: month format and page bounds", () => {
    expect(attendanceRegisterSchema.parse({ month: "2026-11", departmentId: "" })).toEqual({ month: "2026-11", departmentId: null, page: 1 });
    expect(attendanceRegisterSchema.safeParse({ month: "2026-13" }).success).toBe(false);
  });
});

describe("RBAC (L9)", () => {
  it("staff roles read attendance at SELF; managers at ALL; Parent / Student never", () => {
    for (const r of ["TEACHER", "CLASS_TEACHER", "ACCOUNTANT", "ADMISSION_OFFICER", "TRANSPORT_MANAGER", "LIBRARIAN"]) {
      expect(authorize(ctxFor(r), "attendance.employee.read")).toBe("SELF");
    }
    for (const r of ["SCHOOL_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL", "HR_MANAGER", "SUPER_ADMIN"]) {
      expect(authorize(ctxFor(r), "attendance.employee.read")).toBe("ALL");
    }
    for (const r of ["PARENT", "STUDENT"]) expect(() => authorize(ctxFor(r), "attendance.employee.read")).toThrow();
  });
  it("only HR Manager and Super Admin mark", () => {
    const markers = ROLES.filter((r) => {
      try {
        authorize(ctxFor(r.key), "attendance.employee.mark");
        return true;
      } catch {
        return false;
      }
    }).map((r) => r.key);
    expect(markers.sort()).toEqual(["HR_MANAGER", "SUPER_ADMIN"]);
  });
});

describe("service source (rules that need the database are covered in integration)", () => {
  const src = readFileSync(new URL("../../src/modules/hr/staff-attendance.service.ts", import.meta.url), "utf8");
  it("marking takes the calendar lock first, refuses own records, never audits the reason", () => {
    const mark = src.slice(src.indexOf("export async function markAttendanceDay"), src.indexOf("// ───────────────────────────── Day screen"));
    expect(mark.indexOf("lockLeaveCalendar(tx)")).toBeGreaterThan(-1);
    expect(mark.indexOf("lockLeaveCalendar(tx)")).toBeLessThan(mark.indexOf("FOR SHARE"));
    expect(mark).toContain("isOwnRecord(ctx, e.employeeId)");
    expect(mark).toContain("assertActorLinked(ctx)");
    expect(mark).toContain("lockedMonthsBetween");
    const auditCall = mark.slice(mark.indexOf("await audit("));
    expect(auditCall.slice(0, auditCall.indexOf("});"))).not.toMatch(/reason/i);
  });
  it("the register requires ALL; one employee's month allows SELF only on the own record", () => {
    expect(src).toMatch(/authorize\(ctx, "attendance\.employee\.read"\) !== "ALL"\) throw new ForbiddenError/);
    expect(src).toContain('scope !== "ALL" && !(scope === "SELF" && own)');
  });
});
