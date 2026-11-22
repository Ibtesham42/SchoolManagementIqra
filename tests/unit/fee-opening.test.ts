import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { canManageFeeSetup } from "@/modules/fees/fees.policy";
import { findOpeningColumns, openingDueProblem, OPENING_TEMPLATE_HEADER, planOpeningImport, readAmount, type OpeningRosterRow } from "@/modules/fees/opening-import.rules";
import { importOpeningBalances, openingTemplate, previewOpeningImport } from "@/modules/fees/opening-balances.service";
import { openingImportSchema } from "@/modules/fees/opening.schemas";

/** Phase 5C-M3 previous dues (FC19): file matching, amounts, schema, and who may import. */

const roster: OpeningRosterRow[] = [
  { studentId: "s1", studentCode: "STU-1", fullName: "Synthetic One", existing: null },
  { studentId: "s2", studentCode: "STU-2", fullName: "Synthetic Two", existing: null },
  { studentId: "s3", studentCode: "STU-3", fullName: "Synthetic Three", existing: "500.00" },
];
const H = [...OPENING_TEMPLATE_HEADER];

describe("amounts", () => {
  it("accepts digits with commas, Rs. / ₹ and spaces; blank is none; anything else is a problem", () => {
    expect(readAmount("12500")).toBe("12500.00");
    expect(readAmount("Rs. 1,25,000.50")).toBe("125000.50");
    expect(readAmount("₹ 2,500")).toBe("2500.00");
    expect(readAmount("")).toBeNull();
    expect(readAmount("-")).toBeNull();
    expect(readAmount("12.345")).toBeUndefined();
    expect(readAmount("-50")).toBeUndefined();
    expect(readAmount("=1+1")).toBeUndefined();
  });
});

describe("planning an import (pure)", () => {
  it("adds new students, skips ones with previous dues and blanks, totals the new ones", () => {
    const plan = planOpeningImport(
      [H, ["STU-1", "Synthetic One", "4", "A", "1,000"], ["stu-2", "", "", "", "250.50"], ["STU-3", "Synthetic Three", "", "", "500"], ["", "", "", "", ""]],
      roster,
    );
    expect(plan.fileProblem).toBeNull();
    expect(plan.entries).toEqual([
      { studentId: "s1", amount: "1000.00" },
      { studentId: "s2", amount: "250.50" },
    ]);
    expect(plan.counts).toEqual({ new: 2, existing: 1, blank: 0, problems: 0, notInFile: 0 });
    expect(plan.total).toBe("1250.50");
  });
  it("problems: unknown student, duplicate, shifted name, bad amount, implausible amount", () => {
    const plan = planOpeningImport(
      [H, ["STU-9", "", "", "", "10"], ["STU-1", "Synthetic One", "", "", "10"], ["STU-1", "", "", "", "10"], ["STU-2", "Someone Else", "", "", "10"], ["STU-3", "", "", "", "ten"]],
      roster,
    );
    expect(plan.rows.filter((r) => r.problem).map((r) => r.line)).toEqual([2, 4, 5, 6]);
    expect(plan.counts.problems).toBe(4);
    const big = planOpeningImport([H, ["STU-1", "", "", "", "1000000.01"]], roster);
    expect(big.rows[0].problem).toMatch(/10,00,000/);
  });
  it("needs the Student ID and dues columns; finds common header variants", () => {
    expect(planOpeningImport([["Name", "Amount"]], roster).fileProblem).toMatch(/Student ID/);
    expect(planOpeningImport([], roster).fileProblem).toMatch(/empty/);
    expect(findOpeningColumns(["student code", "Full name", "Opening balance"])).toEqual({ student: 0, name: 1, amount: 2 });
  });
  it("blank and zero amounts are 'none', never an invoice", () => {
    const plan = planOpeningImport([H, ["STU-1", "", "", "", "0"], ["STU-2", "", "", "", ""]], roster);
    expect(plan.entries).toEqual([]);
    expect(plan.counts.blank).toBe(2); // "0" and blank both mean none
  });
});

describe("review 5C-M3 L1: due date bounds (pure)", () => {
  const session = { startDate: "2026-04-01", endDate: "2027-03-31" };
  it("inside the session and at most 30 days ago", () => {
    expect(openingDueProblem("2026-07-15", "2026-07-20", session)).toBeNull();
    expect(openingDueProblem("2026-06-20", "2026-07-20", session)).toBeNull(); // exactly 30 days
    expect(openingDueProblem("2026-06-19", "2026-07-20", session)).toMatch(/30 days/);
    expect(openingDueProblem("2099-03-31", "2026-07-20", session)).toMatch(/within the academic session/);
    expect(openingDueProblem("2026-03-31", "2026-04-02", session)).toMatch(/within the academic session/);
  });
});

describe("confirm schema", () => {
  const ok = { academicSessionId: "sess", classId: "cls", dueOn: "2026-07-01", entries: [{ studentId: "s1", amount: "100.00" }], expectedTotal: "100.00" };
  it("strict; positive amounts; no duplicate students; at most 500; a real due date", () => {
    expect(openingImportSchema.safeParse(ok).success).toBe(true);
    expect(openingImportSchema.safeParse({ ...ok, entries: [{ studentId: "s1", amount: "0" }] }).success).toBe(false);
    expect(openingImportSchema.safeParse({ ...ok, entries: [ok.entries[0], ok.entries[0]] }).success).toBe(false);
    expect(openingImportSchema.safeParse({ ...ok, entries: Array.from({ length: 501 }, (_, i) => ({ studentId: `s${i}`, amount: "1" })) }).success).toBe(false);
    expect(openingImportSchema.safeParse({ ...ok, dueOn: "2026-02-30" }).success).toBe(false);
    expect(openingImportSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("who may import previous dues", () => {
  const ref = { academicSessionId: "sess", classId: "cls" };
  it("fee.structure.manage at ALL; everyone else refused before the database", async () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (canManageFeeSetup(ctx)) continue;
      await expect(openingTemplate(ctx, ref, "csv"), role.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(previewOpeningImport(ctx, ref, { bytes: new Uint8Array(), fileName: "x.csv" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(importOpeningBalances(ctx, { ...ref, dueOn: "2026-07-01", entries: [{ studentId: "s1", amount: "1.00" }], expectedTotal: "1.00" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const k of ["PARENT", "STUDENT", "PRINCIPAL", "TEACHER"]) expect(canManageFeeSetup(roleCtx(k)), k).toBe(false);
  });
  it("design guards: setup lock first, closed sessions refused, the previewed total checked, rate-limited routes", () => {
    const svc = readFileSync(new URL("../../src/modules/fees/opening-balances.service.ts", import.meta.url), "utf8");
    const fn = svc.slice(svc.indexOf("export async function importOpeningBalances"));
    expect(fn.indexOf("lockFeeSetup(tx)")).toBeLessThan(fn.indexOf("nextSequenceBlock("));
    expect(fn).toContain("sessionGeneratesInvoices(status)");
    expect(fn).toContain("input.expectedTotal");
    expect(fn.indexOf("openingDueProblem(")).toBeLessThan(fn.indexOf("nextSequenceBlock("));
    const route = readFileSync(new URL("../../src/app/api/v1/fees/opening-balances/template/route.ts", import.meta.url), "utf8");
    expect(route.indexOf("assertSameOrigin(")).toBeLessThan(route.indexOf("enforce(RULES.feeTemplate"));
    expect(route).toContain("readBodyWithLimit(request.body, MAX_FORM_BYTES");
    expect(route).not.toContain("request.formData()");
    const actions = readFileSync(new URL("../../src/app/erp/fees/opening-actions.ts", import.meta.url), "utf8");
    expect(actions.match(/enforce\(RULES\.upload/g)?.length).toBe(2);
  });
});
