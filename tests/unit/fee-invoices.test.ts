import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { canManageFeeSetup, canReadFees } from "@/modules/fees/fees.policy";
import { buildInvoice, repriceItems, type StructureLine } from "@/modules/fees/invoice-build";
import { cancelInvoiceSchema, generateInvoicesSchema } from "@/modules/fees/invoices.schemas";
import { cancelInvoice, getStudentFeeLedger, issueInvoices, listInvoices, previewInvoices } from "@/modules/fees/invoices.service";

/** Phase 5A-M4 invoices: pure building / re-pricing, role gates before the database, schemas. */

const structure: StructureLine[] = [
  { structureItemId: "s1", categoryId: "TUI", categoryName: "Tuition", appliesTo: "ALL", amount: "3000.00" },
  { structureItemId: "s2", categoryId: "ADM", categoryName: "Admission", appliesTo: "NEW_ADMISSION", amount: "5000.00" },
  { structureItemId: "s3", categoryId: "ANN", categoryName: "Annual", appliesTo: "EXISTING", amount: "1000.00" },
  { structureItemId: "s4", categoryId: "LAB", categoryName: "Lab", appliesTo: "ALL", amount: "0.00" },
];

describe("buildInvoice", () => {
  it("new admissions pay admission, existing students pay annual; zero lines are left out", () => {
    const fresh = buildInvoice(structure, [], [], true)!;
    expect(fresh.items.map((i) => i.description)).toEqual(["Tuition", "Admission"]);
    expect(fresh).toMatchObject({ subtotal: "8000.00", concessionTotal: "0.00", total: "8000.00", status: "ISSUED" });
    const old = buildInvoice(structure, [], [], false)!;
    expect(old.items.map((i) => i.description)).toEqual(["Tuition", "Annual"]);
  });
  it("concessions apply to structure lines only, never to extra charges", () => {
    const b = buildInvoice(structure, [{ chargeId: "c1", categoryId: "TUI", categoryName: "Tuition", amount: "500" }], [{ id: "k", calc: "PERCENT", value: "50", categoryIds: ["TUI"] }], false)!;
    expect(b.items.map((i) => [i.kind, i.amount, i.concessionAmount, i.chargeId])).toEqual([
      ["STRUCTURE", "3000.00", "1500.00", null],
      ["STRUCTURE", "1000.00", "0.00", null],
      ["CHARGE", "500.00", "0.00", "c1"],
    ]);
    expect(b).toMatchObject({ subtotal: "4500.00", concessionTotal: "1500.00", total: "3000.00" });
  });
  it("a full concession gives a WAIVED invoice; nothing to bill gives no invoice", () => {
    const w = buildInvoice(structure.slice(0, 1), [], [{ id: "k", calc: "PERCENT", value: "100", categoryIds: ["TUI"] }], false)!;
    expect(w).toMatchObject({ total: "0.00", status: "WAIVED" });
    expect(buildInvoice([structure[3]], [], [], false)).toBeNull();
    expect(buildInvoice([structure[1]], [], [], false)).toBeNull();
  });
});

describe("repriceItems (FC6)", () => {
  const items = [
    { id: "a", kind: "STRUCTURE" as const, categoryId: "TUI", amount: "3000.00", concessionAmount: "0.00" },
    { id: "b", kind: "CHARGE" as const, categoryId: "TUI", amount: "500.00", concessionAmount: "0.00" },
    { id: "c", kind: "LATE_FEE" as const, categoryId: "LATE", amount: "100.00", concessionAmount: "0.00" },
  ];
  it("new concessions reach structure items only; late fees stay outside the subtotal", () => {
    const r = repriceItems(items, [{ id: "k", calc: "FIXED", value: "700", categoryIds: ["TUI"] }]);
    expect(r.items).toEqual([
      { id: "a", concessionAmount: "700.00" },
      { id: "b", concessionAmount: "0.00" },
      { id: "c", concessionAmount: "0.00" },
    ]);
    expect(r).toMatchObject({ subtotal: "3500.00", concessionTotal: "700.00", lateFee: "100.00", total: "2900.00", status: "ISSUED" });
  });
  it("revoking every concession restores the full amount", () => {
    const r = repriceItems([{ ...items[0], concessionAmount: "700.00" }], []);
    expect(r).toMatchObject({ concessionTotal: "0.00", total: "3000.00" });
  });
});

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("invoice role gates (no database)", () => {
  it("only fee setup managers preview, issue and cancel; ledger needs fee.read ALL", async () => {
    const run = { academicSessionId: "s", classId: "c", installmentId: "i" };
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!canManageFeeSetup(ctx)) {
        await expect(previewInvoices(ctx, run), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(issueInvoices(ctx, run), role.key).rejects.toBeInstanceOf(ForbiddenError);
        await expect(cancelInvoice(ctx, { id: "x", version: 1, reason: "Wrong class" }), role.key).rejects.toBeInstanceOf(ForbiddenError);
      }
      if (!canReadFees(ctx)) await expect(getStudentFeeLedger(ctx, "st"), role.key).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const key of ["PARENT", "STUDENT", "TEACHER"]) await expect(listInvoices(roleCtx(key), { academicSessionId: "s", installmentId: "i" }), key).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("review 5A-M4 M2: a custom role with fee.structure.manage or fee.read at a narrow scope gets nothing", async () => {
    for (const scope of ["SELF", "CHILDREN", "ASSIGNED"] as const) {
      const ctx = (key: string): AuthContext => ({ userId: "u", username: "u", displayName: "U", roleKeys: ["C"], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap([{ roleKey: "C", isSystem: false, permissionKey: key as never, scope }]) });
      await expect(issueInvoices(ctx("fee.structure.manage"), { academicSessionId: "s", classId: "c", installmentId: "i" }), scope).rejects.toBeInstanceOf(ForbiddenError);
      await expect(cancelInvoice(ctx("fee.structure.manage"), { id: "x", version: 1, reason: "Wrong" }), scope).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getStudentFeeLedger(ctx("fee.read"), "st"), scope).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listInvoices(ctx("fee.read"), { academicSessionId: "s", installmentId: "i" }), scope).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("schemas", () => {
    expect(generateInvoicesSchema.safeParse({ academicSessionId: "s", classId: "c", installmentId: "i" }).success).toBe(true);
    expect(generateInvoicesSchema.safeParse({ academicSessionId: "s", classId: "c" }).success).toBe(false);
    expect(cancelInvoiceSchema.safeParse({ id: "x", version: "1", reason: "  " }).success).toBe(false);
    expect(cancelInvoiceSchema.safeParse({ id: "x", version: "1", reason: "Billed to the wrong class" }).success).toBe(true);
  });
});
