import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clampMonth, monthBounds, monthOf, shiftMonth, weekdayOf } from "@/lib/month";

// Real PDF renders / first imports of heavy route modules: allow for a loaded machine when the whole suite runs.
vi.setConfig({ testTimeout: 30_000 });

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
    expect(files.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual(["calendar.portal.ts", "fees.portal.ts", "homework.portal.ts", "notices.portal.ts", "notifications.portal.ts", "payment-claims.portal.ts", "results.portal.ts", "student-attendance.portal.ts", "students.portal.ts", "timetable.portal.ts"]);
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
        // Reads by a record id (6B-M2: report-card PDF, homework attachment) load the owning student first (plan §2.2):
        // they must refuse non-portal contexts before the read and run assertPortalStudent before any field leaves.
        if (["renderPortalReportCardPdf", "readPortalHomeworkAttachment", "renderPortalReceiptPdf"].includes(name)) {
          const gate = body.indexOf("if (!ctx.portal) throw new NotFoundError(PORTAL_NOT_FOUND)");
          const firstRead = body.search(/prisma\./);
          if (gate < 0 || gate > firstRead || !body.includes("assertPortalStudent(")) problems.push(`${f.split(/[\\/]/).pop()}: ${name}`);
          continue;
        }
        const check = Math.max(body.indexOf("assertPortalStudent("), body.indexOf("portalVisibleChildren("));
        const read = body.search(/prisma\.|currentEnrollment\(|calendarEntries\(|openInvoicesOf\(/);
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

describe("6B-M2: homework attachments for families, the parent copy", () => {
  it("the file layer: portal accounts need the rule's portal permission and the exact owner; staff keep the staff permission", async () => {
    const { canReadStoredFile } = await import("@/modules/files/files.service");
    const { buildPermissionMap } = await import("@/lib/rbac/authorize");
    const file = { visibility: "PRIVATE" as const, purpose: "homework.attachment", ownerType: "Homework", ownerId: "h1" };
    const access = { purpose: "homework.attachment" as const, owner: { type: "Homework", id: "h1" } };
    const portal = { kind: "GUARDIAN" as const, guardianId: "g", studentId: null, children: [] };
    const ctx = (perms: [string, string][], isPortal: boolean) =>
      ({ userId: "u", username: "u", displayName: "U", roleKeys: [], isSuperAdmin: false, sessionId: "s", portal: isPortal ? portal : null, permissions: buildPermissionMap(perms.map(([k, sc]) => ({ roleKey: "R", isSystem: false, permissionKey: k, scope: sc as never }))) }) as never;
    expect(canReadStoredFile(ctx([["homework.read", "CHILDREN"]], true), file, access)).toBe(true);
    expect(canReadStoredFile(ctx([["homework.read", "CHILDREN"]], true), file, { ...access, owner: { type: "Homework", id: "h2" } })).toBe(false);
    expect(canReadStoredFile(ctx([["academic.read", "ALL"]], true), file, access)).toBe(false); // portal never via the staff permission
    expect(canReadStoredFile(ctx([["academic.read", "ALL"]], false), file, access)).toBe(true); // staff unchanged
    expect(canReadStoredFile(ctx([["homework.read", "CHILDREN"]], false), file, access)).toBe(false);
    // A purpose with no portal permission is never readable from the portal.
    const doc = { visibility: "PRIVATE" as const, purpose: "student.document", ownerType: "StudentDocument", ownerId: "d1" };
    expect(canReadStoredFile(ctx([["student.document.read", "ALL"]], true), doc, { purpose: "student.document" as never, owner: { type: "StudentDocument", id: "d1" } })).toBe(false);
  });

  it("the report card PDF carries PARENT COPY on a portal download only", async () => {
    const { createElement } = await import("react");
    const { renderPdf } = await import("@/lib/pdf/render");
    const { buildBranding } = await import("@/modules/documents/branding");
    const { FALLBACK_PROFILE } = await import("@/modules/settings/settings.public");
    const { ReportCardDocument } = await import("@/modules/documents/templates/report-card");
    const { extractTextRuns, pageText } = await import("../pdf-text");
    const snapshot = {
      v: 1 as const,
      exam: { name: "Synthetic Term 1", session: "2026-27", startDate: null, endDate: null },
      student: { code: "STU-2026-0001", name: "Synthetic Pupil", rollNumber: 3, className: "Class 4", sectionCode: "A" },
      scale: "Synthetic scale",
      subjects: [],
      total: { obtained: "0", max: 0, percent: null, grade: null, result: "NO_RESULT" as const },
      rank: null,
      attendance: { marked: 0, percent: null },
    };
    const render = async (copy?: "PARENT COPY") => pageText(extractTextRuns(await renderPdf(createElement(ReportCardDocument, { branding: buildBranding(FALLBACK_PROFILE), snapshot, remark: null, publishedAt: new Date(), generatedAt: new Date(), copy }))), 1);
    expect(await render("PARENT COPY")).toContain("PARENT COPY");
    expect(await render()).not.toContain("PARENT COPY");
  });
});

describe("6B-M3: fees for parents", () => {
  it("line labels: fee heads as written; FIXED labels for late fees and previous dues (never their text, KI-105)", async () => {
    const { portalLineLabel, portalReceiptLineLabel } = await import("@/modules/fees/fees.portal");
    const line = (kind: string, description: string, amount: string, allocationCount = 0, waivedAmount: string | null = null) => portalLineLabel({ kind, description, waivedAmount, amount, allocationCount });
    expect(line("STRUCTURE", "Tuition", "3000.00")).toBe("Tuition");
    expect(line("CHARGE", "Bus fee", "500.00")).toBe("Bus fee");
    // How waivers are written today (pre-KI-105): a zero LATE_FEE line with the reason in its text, never paid against.
    expect(line("LATE_FEE", "Late fee Rs. 50.00 waived: family hardship", "0.00")).toBe("Late fee waived");
    expect(line("LATE_FEE", "x", "0.00", 0, "50.00")).toBe("Late fee waived"); // the KI-105 columns, once written
    expect(line("LATE_FEE", "VOID_LATE_FEE", "0.00", 2)).toBeNull(); // voided by a receipt cancellation: hidden
    expect(line("LATE_FEE", "Late fee (12 days)", "120.00", 1)).toBe("Late fee");
    expect(line("OPENING_BALANCE", "Old system note", "1000.00")).toBe("Previous dues");
    expect(portalReceiptLineLabel({ installment: "Previous dues", description: "Old system note" })).toBe("Previous dues");
    expect(portalReceiptLineLabel({ installment: "Q1", description: "Late fee waived: reason" })).toBe("Late fee");
    expect(portalReceiptLineLabel({ installment: "Q1", description: "Tuition" })).toBe("Tuition");
  });

  it("static guards: no reasons, references, collectors or print counting in fees.portal.ts; students never see fees", async () => {
    const src = readFileSync(join(ROOT, "src", "modules", "fees", "fees.portal.ts"), "utf8");
    expect(src).not.toMatch(/waiverReason|cancelReason|transactionRef|collectedBy: \{|print_count|printCount/);
    expect(src).toMatch(/reference: null,\s*bankName: null,\s*instrumentDate: null/);
    expect(src).toMatch(/collectedBy: null/);
    expect(src).toMatch(/copy: "PARENT"/);
    // Review L2 / L3: totals from the counter's open-invoice read; the banner grouped in the database.
    expect(src).toMatch(/dueToday: moneyString\(sumMoney\(open\.flatMap\(\(o\) => \[o\.balance, o\.lateFee\]\)\)\)/);
    expect(src).toMatch(/feeInvoice\.groupBy\(\{\s*by: \["studentId"\]/);
    const { portalCanSee } = await import("@/lib/rbac/portal-scope");
    const student = { kind: "STUDENT" as const, children: [{ studentId: "s", status: "ACTIVE" as const, leftOn: null, portalAccess: true }] };
    expect(portalCanSee(student, () => "SELF", "s", "fees", { today: "2026-11-23", leaverAccessDays: 180 })).toBe(false);
  });

  it("the receipt PDF says PARENT COPY on a portal download", async () => {
    const { createElement } = await import("react");
    const { renderPdf } = await import("@/lib/pdf/render");
    const { buildBranding } = await import("@/modules/documents/branding");
    const { FALLBACK_PROFILE } = await import("@/modules/settings/settings.public");
    const { FeeReceiptDocument } = await import("@/modules/documents/templates/fee-receipt");
    const { extractTextRuns, pageText } = await import("../pdf-text");
    const receipt = { receiptNo: "RCT/1", paidOn: "1 Jul 2026", student: { name: "Synthetic", studentCode: "STU-1", className: "C", sectionCode: "A" }, method: "Cash", reference: null, bankName: null, instrumentDate: null, lines: [], amount: "10.00", amountInWords: null, collectedBy: null };
    const text = pageText(extractTextRuns(await renderPdf(createElement(FeeReceiptDocument, { branding: buildBranding(FALLBACK_PROFILE), receipt, copy: "PARENT", cancelled: false, generatedAt: new Date() }))), 1);
    expect(text).toContain("PARENT COPY");
    expect(text).not.toContain("OFFICE COPY");
  });
});
