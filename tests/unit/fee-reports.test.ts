import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { toCsv } from "@/lib/csv";
import { canReadFeeReports } from "@/modules/fees/fees.policy";
import { concessionValueText, daysBefore, daysBetween, groupOutstandingByClass, REMOVED, waiverAmount } from "@/modules/fees/report-rows";
import { reportQuerySchema } from "@/modules/fees/reports.schemas";
import { exportFeeReport, feeReportOptions, runFeeReport } from "@/modules/fees/reports.service";
import { canExportGuardianContacts, canReadGuardianContacts } from "@/modules/students/guardian-contacts.tx";

/** Phase 5C-M1 fee reports: pure grouping / parsing, filters, who may read / export, guardian-contact gate. */

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}
const custom = (grants: [string, "ALL" | "SELF" | "CHILDREN" | "ASSIGNED"][]): AuthContext => ({
  userId: "u",
  username: "u",
  displayName: "U",
  roleKeys: ["C"],
  sessionId: "s",
  isSuperAdmin: false,
  permissions: buildPermissionMap(grants.map(([k, scope]) => ({ roleKey: "C", isSystem: false, permissionKey: k as never, scope }))),
});

describe("outstanding by class (pure)", () => {
  const roster = new Map([
    ["s1", { className: "Class 2", sectionCode: "A", classLevel: 2 }],
    ["s2", { className: "Class 2", sectionCode: "A", classLevel: 2 }],
    ["s3", { className: "Class 1", sectionCode: "B", classLevel: 1 }],
  ]);
  it("groups students by section, orders by class level, and keeps removed students so totals match the invoices", () => {
    const rows = groupOutstandingByClass(
      [
        { studentId: "s1", invoices: 2, open: 1, total: "6000.00", paid: "3000.00" },
        { studentId: "s2", invoices: 2, open: 2, total: "6000.10", paid: "0.00" },
        { studentId: "s3", invoices: 1, open: 0, total: "2500.00", paid: "2500.00" },
        { studentId: "gone", invoices: 1, open: 1, total: "100.00", paid: "0.00" },
      ],
      roster,
    );
    expect(rows.map((r) => [r.className, r.sectionCode])).toEqual([
      ["Class 1", "B"],
      ["Class 2", "A"],
      [REMOVED, ""],
    ]);
    expect(rows[1]).toMatchObject({ students: 2, invoices: 4, open: 3, total: "12000.10", paid: "3000.00", balance: "9000.10" });
    expect(rows[2]).toMatchObject({ students: 1, balance: "100.00" });
  });
});

describe("report helpers (pure)", () => {
  it("days overdue and cut-off dates (never negative)", () => {
    expect(daysBetween("2026-07-01", "2026-08-10")).toBe(40);
    expect(daysBetween("2026-08-10", "2026-07-01")).toBe(0);
    expect(daysBefore("2026-03-01", 1)).toBe("2026-02-28");
  });
  it("a waiver line gives its amount, never its reason (KI-105, §11 I4)", () => {
    expect(waiverAmount("Late fee ₹100.00 waived: Synthetic hardship")).toBe("100.00");
    expect(waiverAmount("Late fee (void: receipt cancelled)")).toBeNull();
    expect(waiverAmount("Late fee")).toBeNull();
  });
  it("concession values", () => {
    expect(concessionValueText("PERCENT", "10.00")).toBe("10%");
    expect(concessionValueText("FIXED", "500")).toBe("Rs. 500.00 per installment");
  });
  it("CSV cells stay formula-safe (names typed by staff end up in reports)", () => {
    const csv = toCsv(["Name"], [["=HYPERLINK(\"x\")"], ["+91 98"], ["@SUM(A1)"]]);
    expect(csv).not.toMatch(/\r\n=|\r\n\+|\r\n@/);
  });
});

describe("report filters", () => {
  it("session reports need a session; range reports need dates within a year, in order; strict", () => {
    expect(reportQuerySchema.safeParse({ report: "outstanding" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ report: "outstanding", academicSessionId: "sess1" }).success).toBe(true);
    expect(reportQuerySchema.safeParse({ report: "collection" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ report: "collection", from: "2026-07-01", to: "2026-07-31" }).success).toBe(true);
    expect(reportQuerySchema.safeParse({ report: "collection", from: "2026-07-31", to: "2026-07-01" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ report: "collection", from: "2025-07-01", to: "2026-07-31" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ report: "collection", from: "2026-02-30", to: "2026-03-01" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ report: "nope", academicSessionId: "s" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ report: "defaulters", academicSessionId: "s", minDays: "400" }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ report: "defaulters", academicSessionId: "s", extra: "1" }).success).toBe(false);
    expect(reportQuerySchema.parse({ report: "defaulters", academicSessionId: "s" })).toMatchObject({ minDays: 1, groupBy: "day", by: "class" });
  });
});

describe("who reads, exports and sees guardian contacts (table-driven over the catalog)", () => {
  const q = reportQuerySchema.parse({ report: "outstanding", academicSessionId: "sess1" });
  it("fee.report at ALL reads reports; everyone else is refused before the database", async () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!canReadFeeReports(ctx)) {
        await expect(runFeeReport(ctx, q), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(feeReportOptions(ctx), role.key).rejects.toBeInstanceOf(ForbiddenError);
      }
    }
    for (const k of ["SUPER_ADMIN", "ACCOUNTANT", "PRINCIPAL", "VICE_PRINCIPAL"]) expect(canReadFeeReports(roleCtx(k)), k).toBe(true);
    for (const k of ["PARENT", "STUDENT"]) expect(canReadFeeReports(roleCtx(k)), k).toBe(false);
  });
  it("export also needs export.run", async () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!canReadFeeReports(ctx) || !hasPermission(ctx, "export.run")) await expect(exportFeeReport(ctx, q), role.key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("narrow scopes count for nothing", async () => {
    const ctx = custom([["fee.report", "CHILDREN"], ["export.run", "ALL"]]);
    expect(canReadFeeReports(ctx)).toBe(false);
    await expect(exportFeeReport(ctx, q)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("review M1: contacts in a CSV also need admission.read ALL (D8); the Accountant sees them, can't download them", () => {
    expect(canReadGuardianContacts(roleCtx("ACCOUNTANT"))).toBe(true);
    expect(canExportGuardianContacts(roleCtx("ACCOUNTANT"))).toBe(false);
    expect(canExportGuardianContacts(custom([["student.read", "ALL"], ["admission.read", "ALL"]]))).toBe(true);
    expect(canExportGuardianContacts(custom([["student.read", "ALL"], ["admission.read", "ASSIGNED"]]))).toBe(false);
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (canExportGuardianContacts(ctx)) expect(canReadGuardianContacts(ctx), role.key).toBe(true);
    }
  });
  it("guardian contacts need whole-school student.read", () => {
    expect(canReadGuardianContacts(custom([["student.read", "ASSIGNED"]]))).toBe(false);
    expect(canReadGuardianContacts(custom([["student.read", "ALL"]]))).toBe(true);
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (canReadFeeReports(ctx)) expect(typeof canReadGuardianContacts(ctx), role.key).toBe("boolean");
    }
  });
  it("the export route checks origin, session and rate limit before parsing; the service never lists reasons or references", () => {
    const route = readFileSync(new URL("../../src/app/api/v1/fees/reports/[name]/export/route.ts", import.meta.url), "utf8");
    const order = ["assertSameOrigin(", "getAuthContext()", "enforce(RULES.export", "reportQuerySchema.safeParse", "exportFeeReport("].map((s) => route.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const svc = readFileSync(new URL("../../src/modules/fees/reports.service.ts", import.meta.url), "utf8");
    expect(svc).not.toMatch(/cancel_reason|cancelReason|reason: true|transaction_ref|transactionRef|aadhaar_(enc|hmac)/);
    expect(svc).toContain("forExport ? canExportGuardianContacts(ctx) : canReadGuardianContacts(ctx)");
    expect(svc).toContain("build(ctx, q, true)");
  });
});
