import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clampMonth, monthBounds, monthOf, shiftMonth, weekdayOf } from "@/lib/month";

/** Phase 6B-M1 — month helpers and the static guards for every portal read module. */

describe("month helpers", () => {
  it("bounds, including February in leap and common years", () => {
    expect(monthBounds("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthBounds("2027-02")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(monthBounds("2026-12").to).toBe("2026-12-31");
  });

  it("shift across years; month of a date; weekday without time-zone drift", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(monthOf("2026-11-23")).toBe("2026-11");
    expect(weekdayOf("2026-11-23")).toBe(1); // a Monday
  });

  it("clamp: a valid month inside the session; junk or out-of-range falls back into the session", () => {
    const [start, end] = ["2026-04-01", "2027-03-31"];
    expect(clampMonth("2026-09", start, end, "2026-11-23")).toBe("2026-09");
    expect(clampMonth(undefined, start, end, "2026-11-23")).toBe("2026-11");
    expect(clampMonth("2026-13", start, end, "2026-11-23")).toBe("2026-11");
    expect(clampMonth("2025-01", start, end, "2026-11-23")).toBe("2026-04");
    expect(clampMonth("2030-01", start, end, "2026-11-23")).toBe("2027-03");
    expect(clampMonth("x' OR 1=1", start, end, "2028-01-01")).toBe("2027-03"); // today after the session
  });
});

const ROOT = join(__dirname, "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

describe("static guards: every *.portal.ts read runs the portal check before reading", () => {
  const files = walk(join(ROOT, "src", "modules")).filter((f) => f.endsWith(".portal.ts"));

  it("all four portal modules exist", () => {
    expect(files.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual(["calendar.portal.ts", "student-attendance.portal.ts", "students.portal.ts", "timetable.portal.ts"]);
  });

  it("each exported async function checks access first (assertPortalStudent / portalVisibleChildren)", () => {
    const problems: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // Review 6B-M1 L2: only `export async function` (or `export function` without data) may appear — no exported arrows.
      expect(src, f).not.toMatch(/\nexport const \w+ = (async )?\(/);
      for (const body of src.split(/\nexport async function /).slice(1)) {
        const name = body.slice(0, body.indexOf("("));
        if (name === "portalWindow") continue;
        const check = Math.max(body.indexOf("assertPortalStudent("), body.indexOf("portalVisibleChildren("));
        const read = body.search(/prisma\.|currentEnrollment\(|calendarEntries\(/);
        if (check < 0 || (read >= 0 && read < check)) problems.push(`${f.split(/[\\/]/).pop()}: ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("data minimisation: no staff codes / contacts, no correction reasons or markers, no internal ids from the calendar", () => {
    const tt = readFileSync(join(ROOT, "src", "modules", "academic", "timetable.portal.ts"), "utf8");
    expect(tt).not.toMatch(/employeeCode|phone|email/);
    expect(tt).toMatch(/employee: \{ select: \{ fullName: true, employmentStatus: true, deletedAt: true \} \}/); // exactly these fields
    expect(tt).toMatch(/employmentStatus === "ACTIVE" \|\| emp\.employmentStatus === "ON_LEAVE"/); // departed staff not named
    const att = readFileSync(join(ROOT, "src", "modules", "students", "student-attendance.portal.ts"), "utf8");
    expect(att).not.toMatch(/correctionReason|markedBy/);
    const cal = readFileSync(join(ROOT, "src", "modules", "academic", "calendar.portal.ts"), "utf8");
    expect(cal).toMatch(/classId: e\.classId/); // only the child's own class's exam dates
    expect(cal).toMatch(/from "\.\/calendar-reads\.tx"/); // review L3: not a staff service
    expect(cal).not.toMatch(/examId:|version:|\bid: x\.id/);
  });
});

describe("review 6B-M1 M1: sessions longer than a year", () => {
  it("classifies a 548-day session in chunks (no 'Range too long'), every day once and in order", async () => {
    const { classifyLongRange } = await import("@/modules/students/student-attendance.portal");
    const w = { days: [0], saturdays: [] } as never; // Sundays off
    const days = classifyLongRange("2026-01-01", "2027-07-02", w, new Set(["2026-08-15"]));
    expect(days).toHaveLength(548);
    expect(days[0].date).toBe("2026-01-01");
    expect(days.at(-1)!.date).toBe("2027-07-02");
    expect(new Set(days.map((d) => d.date)).size).toBe(548);
    expect(days.find((d) => d.date === "2026-08-15")!.kind).toBe("holiday");
    expect(days.find((d) => d.date === "2026-01-04")!.kind).toBe("weekly_off"); // a Sunday
  });
});
