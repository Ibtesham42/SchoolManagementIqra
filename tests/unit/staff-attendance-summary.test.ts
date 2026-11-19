import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, RateLimitedError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { canViewAttendanceSummary } from "@/modules/hr/hr.policy";
import { classifyRange } from "@/modules/hr/leave.rules";
import { PAYROLL_SUMMARY_HEADER, payrollMonthSummary } from "@/modules/hr/staff-attendance.rules";
import { payrollSummaryExportSchema } from "@/modules/hr/staff-attendance.schemas";

/**
 * Phase 3B M5 — payroll hand-off summary: pure LOP rules, access policy over every role, the CSV route (stubbed
 * service) and the real service's gates (refused before any database access). Database behaviour:
 * tests/integration/hr-staff-attendance.test.ts.
 */
type Ctx = { userId: string } | null;
let ctx: Ctx = { userId: "u1" };
let rateLimited = false;
let exportBehaviour: (args: unknown[]) => Promise<unknown> = async () => ({ csv: "﻿Employee ID\r\n", rows: 0 });
const calls: unknown[][] = [];

vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx }));
vi.mock("@/lib/rate-limit", () => ({
  RULES: { export: { name: "export", limit: 10, windowSeconds: 600 } },
  enforce: async () => {
    if (rateLimited) throw new RateLimitedError();
  },
}));
vi.mock("@/modules/hr/staff-attendance.service", async (orig) => ({
  ...(await orig<typeof import("@/modules/hr/staff-attendance.service")>()),
  exportPayrollAttendanceSummary: (...args: unknown[]) => {
    calls.push(args);
    return exportBehaviour(args);
  },
}));

const { POST } = await import("@/app/api/v1/staff-attendance/summary/export/route");
const APP = "http://127.0.0.1:3000";

function exportRequest(opts: { body?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const body = opts.body ?? "month=2026-10";
  const headers: Record<string, string> = {
    origin: APP,
    host: "127.0.0.1:3000",
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(Buffer.byteLength(body)),
    accept: opts.html ? "text/html,application/xhtml+xml" : "application/json",
    ...opts.headers,
  };
  return POST(new Request(`${APP}/api/v1/staff-attendance/summary/export`, { method: "POST", headers, body }));
}

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return {
    userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s",
    isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), employeeId: "me",
  };
}

beforeEach(() => {
  ctx = { userId: "u1" };
  rateLimited = false;
  calls.length = 0;
  exportBehaviour = async () => ({ csv: "﻿Employee ID\r\n", rows: 0 });
});

describe("payrollMonthSummary (LOP rules)", () => {
  // November 2026: Sundays off; staff holiday on the 14th (Saturday).
  const days = classifyRange("2026-11-01", "2026-11-30", { days: [0], saturdays: [] }, new Set(["2026-11-14"]));
  const mark = (status: string, leavePaid: boolean | null = null) => ({ status, leaveRequestId: leavePaid === null ? null : "lr", leavePaid });

  it("LOP = absent + unpaid leave + ½ per manual half day; paid leave is not LOP", () => {
    const rows = new Map(
      days.filter((d) => d.kind === "working").map((d) => [d.date, mark("PRESENT")] as const),
    );
    rows.set("2026-11-02", mark("ABSENT"));
    rows.set("2026-11-03", mark("HALF_DAY"));
    rows.set("2026-11-04", mark("ON_LEAVE", true));
    rows.set("2026-11-05", mark("ON_LEAVE", false));
    rows.set("2026-11-06", mark("HALF_DAY", false));
    rows.set("2026-11-07", mark("HALF_DAY", true));
    rows.set("2026-11-09", mark("LATE"));
    const s = payrollMonthSummary(days, rows, () => true, "2026-12-05");
    expect(s.workingDays).toBe(24); // 30 − 5 Sundays (1, 8, 15, 22, 29) − 1 holiday
    expect([s.weeklyOffs, s.holidays]).toEqual([5, 1]);
    expect(s.paidLeave.toString()).toBe("1.5");
    expect(s.unpaidLeave.toString()).toBe("1.5");
    expect(s.lopDays.toString()).toBe("3"); // 1 absent + 1.5 unpaid + 0.5 manual half
    expect([s.absent, s.halfDays, s.late, s.unmarked]).toEqual([1, 1, 1, 0]);
    expect(s.complete).toBe(true);
  });
  it("unmarked days are counted, never LOP, and make the month incomplete; so does a month not over", () => {
    const s = payrollMonthSummary(days, new Map([["2026-11-02", mark("PRESENT")]]), () => true, "2026-12-01");
    expect(s.unmarked).toBe(s.workingDays - 1);
    expect(s.lopDays.toString()).toBe("0");
    expect(s.complete).toBe(false);
    const all = new Map(days.filter((d) => d.kind === "working").map((d) => [d.date, mark("PRESENT")] as const));
    expect(payrollMonthSummary(days, all, () => true, "2026-11-30").complete).toBe(false); // last day not over
    expect(payrollMonthSummary(days, all, () => true, "2026-12-01").complete).toBe(true);
  });
  it("only days on the rolls count (mid-month joiner)", () => {
    const s = payrollMonthSummary(days, new Map(), (d) => d >= "2026-11-16", "2026-12-01");
    expect(s.workingDays).toBe(13); // 16–30 minus Sundays 22, 29
    expect(s.weeklyOffs).toBe(2);
    expect(s.holidays).toBe(0);
    // Audit M5-M1: the month total stays the proration denominator.
    expect([s.monthWorkingDays, s.offRollsDays]).toEqual([24, 11]);
  });
  it("a leaver: days after leaving are off the rolls, never LOP", () => {
    const s = payrollMonthSummary(days, new Map(), (d) => d <= "2026-11-10", "2026-12-01");
    expect([s.monthWorkingDays, s.workingDays, s.offRollsDays]).toEqual([24, 8, 16]);
    expect(s.lopDays.toString()).toBe("0");
  });
  it("a leave row with an unknown type counts as unpaid and flags the month for review", () => {
    const all = new Map(days.filter((d) => d.kind === "working").map((d) => [d.date, mark("PRESENT")] as const));
    all.set("2026-11-02", { status: "ON_LEAVE", leaveRequestId: "lr", leavePaid: null });
    const s = payrollMonthSummary(days, all, () => true, "2026-12-01");
    expect(s.unpaidLeave.toString()).toBe("1");
    expect(s.complete).toBe(false);
  });
});

describe("summary access (every role)", () => {
  it("ALL attendance readers and payroll preparers; never SELF-only staff, Parent or Student", () => {
    const allowed = ROLES.filter((r) => canViewAttendanceSummary(roleCtx(r.key))).map((r) => r.key).sort();
    expect(allowed).toEqual(["ACCOUNTANT", "HR_MANAGER", "PRINCIPAL", "SCHOOL_ADMIN", "SUPER_ADMIN", "VICE_PRINCIPAL"]);
  });
  it("the CSV header has counts only — no reasons, leave types or personal fields", () => {
    expect(PAYROLL_SUMMARY_HEADER.join(" ")).not.toMatch(/reason|type of leave|leave type|birth|phone|address|salary|bank/i);
  });
  it("export filters are strict", () => {
    expect(payrollSummaryExportSchema.parse({ month: "2026-10", departmentId: "" })).toEqual({ month: "2026-10", departmentId: null });
    expect(payrollSummaryExportSchema.safeParse({ month: "2026-10", departmentId: "", page: 2 }).success).toBe(false);
    expect(payrollSummaryExportSchema.safeParse({ month: "10-2026", departmentId: "" }).success).toBe(false);
  });
});

describe("POST /api/v1/staff-attendance/summary/export", () => {
  it("returns a CSV attachment named by month, never cached", async () => {
    const r = await exportRequest({ body: "month=2026-10&department=dep1" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="staff-attendance-2026-10.csv"');
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(calls[0][1]).toEqual({ month: "2026-10", departmentId: "dep1" });
  });
  it("refuses cross-site requests before the session or service (CSRF); 401 / 429", async () => {
    expect((await exportRequest({ headers: { origin: "https://evil.example" } })).status).toBe(403);
    ctx = null;
    const html = await exportRequest({ html: true });
    expect([html.status, html.headers.get("location")]).toEqual([303, "/login"]);
    ctx = { userId: "u1" };
    rateLimited = true;
    expect((await exportRequest()).status).toBe(429);
    expect(calls).toHaveLength(0);
  });
  it("refuses large / non-form bodies and invalid months; browser posts redirect with a fixed code", async () => {
    expect((await exportRequest({ body: `month=2026-10&x=${"a".repeat(2000)}` })).status).toBe(422);
    expect((await exportRequest({ headers: { "content-type": "application/json" } })).status).toBe(422);
    const bad = await exportRequest({ body: "month=<script>", html: true });
    expect([bad.status, bad.headers.get("location")]).toEqual([303, "/erp/staff-attendance/summary?export=invalid"]);
    exportBehaviour = async () => {
      throw new ConflictError("<b>any text</b>");
    };
    const r = await exportRequest({ html: true });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/erp/staff-attendance/summary?month=2026-10&export=too_many"]);
    expect(calls).toHaveLength(1);
  });
});

describe("summary service gates (real service; refused before any database access)", () => {
  it("export needs export.run AND summary access; the page needs summary access", async () => {
    const real = await vi.importActual<typeof import("@/modules/hr/staff-attendance.service")>("@/modules/hr/staff-attendance.service");
    const input = { month: "2026-10", departmentId: null };
    for (const role of ["PRINCIPAL", "TEACHER", "LIBRARIAN", "PARENT", "STUDENT"]) {
      await expect(real.exportPayrollAttendanceSummary(roleCtx(role), input), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const role of ["TEACHER", "LIBRARIAN", "TRANSPORT_MANAGER", "PARENT", "STUDENT"]) {
      await expect(real.getPayrollAttendanceSummary(roleCtx(role), { ...input, page: 1 }), role).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
