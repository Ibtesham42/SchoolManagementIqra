import { readFileSync } from "node:fs";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { extractTextRuns, nonWinAnsiChars, pageText } from "../pdf-text";
import { renderPdf } from "@/lib/pdf/render";
import { buildBranding } from "@/modules/documents/branding";
import { SalarySlipDocument, type SalarySlipData } from "@/modules/documents/templates/salary-slip";
import { renderSlipPdf } from "@/modules/payroll/slips.service";
import { FALLBACK_PROFILE } from "@/modules/settings/settings.public";

/** Phase 3C P12 salary slip PDF — real rendering with synthetic data, printable characters, and access gates. */
const slip: SalarySlipData = {
  slipNo: "SLIP-2026-00001",
  month: "2026-10",
  employee: { code: "EMP-2020-0001", name: "Synthetic Teacher", designation: "Teacher", department: "Science" },
  dayBasis: "working days",
  monthDays: 26,
  offRollsDays: 0,
  lopDays: "1",
  paidDays: "25",
  earnings: [
    { name: "Basic", amount: "28846.15" },
    { name: "Bonus: Synthetic bonus", amount: "1000.00" },
  ],
  deductions: [{ name: "Provident fund", amount: "3461.54" }],
  gross: "29846.15",
  totalDeductions: "3461.54",
  net: "26384.61",
  paidStatus: "Paid",
};

describe("salary slip PDF", () => {
  it("renders a one-page A4 PDF with the slip number, net pay and WinAnsi-only text (no ₹)", async () => {
    const pdf = await renderPdf(createElement(SalarySlipDocument, { branding: buildBranding(FALLBACK_PROFILE), slip, generatedAt: new Date() }));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pageText(extractTextRuns(pdf), 1);
    expect(text).toContain("SLIP-2026-00001");
    expect(text).toContain("Rs. 26384.61");
    expect(text).toContain("Synthetic Teacher");
    expect(nonWinAnsiChars(text)).toEqual([]);
    expect(text).not.toMatch(/PAN|IFSC|account/i); // KI-088: no bank details on slips
  }, 30_000);
});

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows) };
}

describe("slip PDF access", () => {
  it("Parent and Student are refused before any database access; the service reuses getSlip's checks", async () => {
    for (const key of ["PARENT", "STUDENT"]) await expect(renderSlipPdf(roleCtx(key), "s"), key).rejects.toBeInstanceOf(ForbiddenError);
    const src = readFileSync(new URL("../../src/modules/payroll/slips.service.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function renderSlipPdf"));
    expect(fn.indexOf("await getSlip(ctx, slipId)")).toBeLessThan(fn.indexOf("renderPdf("));
    expect(fn).toContain('slip.run.status !== "APPROVED" && slip.run.status !== "PAID"');
  });
});
