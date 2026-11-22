import { readFileSync } from "node:fs";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { RULES } from "@/lib/rate-limit";
import { renderPdf } from "@/lib/pdf/render";
import { buildBranding } from "@/modules/documents/branding";
import { FeeReceiptDocument, type FeeReceiptData } from "@/modules/documents/templates/fee-receipt";
import { canReadReceipts } from "@/modules/fees/fees.policy";
import { renderReceiptPdf } from "@/modules/fees/receipts.service";
import { FALLBACK_PROFILE } from "@/modules/settings/settings.public";
import { extractTextRuns, nonWinAnsiChars, pageText } from "../pdf-text";

/** Phase 5B-M2 fee receipt PDF (FC14) — real rendering with synthetic data, stamps, printable text and access gates. */
const receipt: FeeReceiptData = {
  receiptNo: "RCT/2026/00042",
  paidOn: "15 Jul 2026",
  student: { name: "Synthetic Payer", studentCode: "STU-2026-0001", className: "Class 4", sectionCode: "A" },
  method: "Cheque",
  reference: "004512",
  bankName: "SYNTHETIC BANK",
  instrumentDate: "14 Jul 2026",
  lines: [
    { invoiceNo: "INV/2026/00007", session: "2026-27", installment: "Q1", description: "Tuition", amount: "3000.00" },
    { invoiceNo: "INV/2026/00007", session: "2026-27", installment: "Q1", description: "Late fee", amount: "100.00" },
  ],
  amount: "3100.00",
  amountInWords: "Rupees Three Thousand One Hundred Only",
  collectedBy: "Synthetic Accountant",
};
const render = async (copy: "ORIGINAL" | "DUPLICATE" | "COPY", cancelled: boolean) => {
  const pdf = await renderPdf(createElement(FeeReceiptDocument, { branding: buildBranding(FALLBACK_PROFILE), receipt, copy, cancelled, generatedAt: new Date() }));
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  return pageText(extractTextRuns(pdf), 1);
};

describe("fee receipt PDF", () => {
  it("the original: receipt number, student, lines, total in figures and words, WinAnsi-only text (no ₹), no stamp", async () => {
    const text = await render("ORIGINAL", false);
    for (const s of ["RCT/2026/00042", "Synthetic Payer", "STU-2026-0001", "Rs. 3100.00", "Rs. 100.00", "Three Thousand One Hundred", "004512", "SYNTHETIC BANK", "Synthetic Accountant"]) expect(text, s).toContain(s);
    expect(nonWinAnsiChars(text)).toEqual([]);
    expect(text).not.toMatch(/DUPLICATE|CANCELLED/);
  }, 30_000);
  it("later prints say DUPLICATE; a cancelled receipt says CANCELLED on every copy", async () => {
    expect(await render("DUPLICATE", false)).toContain("DUPLICATE");
    const cancelled = await render("ORIGINAL", true);
    expect(cancelled).toContain("CANCELLED");
    expect(cancelled).not.toContain("DUPLICATE");
    expect(await render("DUPLICATE", true)).toMatch(/CANCELLED[\s\S]*DUPLICATE/);
    const office = await render("COPY", false);
    expect(office).toContain("OFFICE COPY");
    expect(office).not.toContain("DUPLICATE");
  }, 30_000);
});

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("receipt PDF access and design guards", () => {
  it("every role that can't read receipts is refused before the database (Parent and Student included)", async () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!canReadReceipts(ctx)) await expect(renderReceiptPdf(ctx, "p1"), role.key).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const key of ["PARENT", "STUDENT"]) expect(canReadReceipts(roleCtx(key)), key).toBe(false);
  });
  it("renders FIRST, then counts under the student lock only if count + status are unchanged; only collectors count; version never bumped", () => {
    const src = readFileSync(new URL("../../src/modules/fees/receipts.service.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function renderReceiptPdf"));
    expect(fn.indexOf("renderPdf(")).toBeLessThan(fn.indexOf("$transaction("));
    expect(fn.indexOf("lockFeeStudent(tx")).toBeLessThan(fn.indexOf("print_count = print_count + 1"));
    expect(fn).toContain("AND print_count = ${p.printCount} AND status = ${p.status}");
    expect(fn).toContain('const counts = holdsAll(ctx, "fee.collect")');
    expect(fn).toContain('!counts ? "COPY"');
    expect(fn.indexOf("fee_payment.print")).toBeGreaterThan(0);
    expect(fn).not.toMatch(/version: \{ increment/);
  });
  it("the route is rate limited per user and refuses cross-site requests", () => {
    expect(RULES.receiptPdf.limit).toBeGreaterThan(0);
    const route = readFileSync(new URL("../../src/app/api/v1/fees/receipts/[id]/pdf/route.ts", import.meta.url), "utf8");
    expect(route).toContain("enforce(RULES.receiptPdf, ctx.userId)");
    expect(route).toContain("sec-fetch-site");
    expect(route.indexOf("enforce(RULES.receiptPdf")).toBeLessThan(route.indexOf("renderReceiptPdf(ctx"));
  });
});
