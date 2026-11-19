import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { maskEnd, updateBankDetailsSchema } from "@/modules/hr/bank-details.schemas";
import { getBankDetails, updateBankDetails } from "@/modules/hr/bank-details.service";

/** Phase 3C (P8) PAN / bank details — formats, masking, gates over every role, and the no-values-in-audit contract. */
function roleCtx(roleKey: string, extra: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), ...extra };
}
const base = { employeeId: "e", version: "1", pan: "", bankAccount: "", bankIfsc: "", bankAccountName: "", removePan: "", removeBank: "" };

describe("formats", () => {
  it("normalizes PAN / IFSC to upper case and strips spaces from the account; blank keeps the saved value", () => {
    const v = updateBankDetailsSchema.parse({ ...base, pan: " abcde 1234f ", bankAccount: "1234 5678 9012", bankIfsc: "sbin0001234", bankAccountName: "  Synthetic  Name " });
    // Review P8 L1: a new account needs its IFSC and name in the same submission.
    expect(updateBankDetailsSchema.safeParse({ ...base, bankAccount: "123456789012" }).success).toBe(false);
    expect(v).toMatchObject({ pan: "ABCDE1234F", bankAccount: "123456789012", bankIfsc: "SBIN0001234", bankAccountName: "Synthetic Name" });
    expect(updateBankDetailsSchema.parse(base)).toMatchObject({ pan: null, bankAccount: null, bankIfsc: null, bankAccountName: null, removePan: false });
  });
  it("refuses bad PAN, short accounts, bad IFSC, and 'enter + remove' together", () => {
    expect(updateBankDetailsSchema.safeParse({ ...base, pan: "ABCD1234F" }).success).toBe(false);
    expect(updateBankDetailsSchema.safeParse({ ...base, bankAccount: "12345678" }).success).toBe(false);
    expect(updateBankDetailsSchema.safeParse({ ...base, bankIfsc: "SBIN1001234" }).success).toBe(false);
    expect(updateBankDetailsSchema.safeParse({ ...base, pan: "ABCDE1234F", removePan: "on" }).success).toBe(false);
    expect(updateBankDetailsSchema.safeParse({ ...base, bankIfsc: "SBIN0001234", removeBank: "on" }).success).toBe(false);
  });
  it("masks all but the last 4 characters", () => {
    expect(maskEnd("ABCDE1234F")).toBe("XXXXXX234F");
    expect(maskEnd("123456789012")).toBe("XXXXXXXX9012");
    expect(maskEnd("123")).toBe("XXX");
  });
});

describe("gates (every role)", () => {
  it("reading needs employee.sensitive.read (HR Manager, Super Admin); changing also employee.manage; never one's own", async () => {
    const readers = ROLES.filter((r) => r.key === "SUPER_ADMIN" || roleCtx(r.key).permissions.has("employee.sensitive.read")).map((r) => r.key).sort();
    expect(readers).toEqual(["HR_MANAGER", "SUPER_ADMIN"]);
    const input = updateBankDetailsSchema.parse(base);
    for (const r of ROLES.filter((x) => !readers.includes(x.key))) {
      await expect(getBankDetails(roleCtx(r.key), "e"), r.key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateBankDetails(roleCtx(r.key, { employeeId: "me" }), input), r.key).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(updateBankDetails(roleCtx("HR_MANAGER", { employeeId: "e" }), input)).rejects.toThrow(/your own/);
    await expect(updateBankDetails(roleCtx("HR_MANAGER"), input)).rejects.toThrow(/linked/);
  });
});

describe("service source", () => {
  const src = readFileSync(new URL("../../src/modules/hr/bank-details.service.ts", import.meta.url), "utf8");
  it("only masked values leave the service; the audit row holds change flags, never values", () => {
    expect(src).toContain("pan: safeMask(e.panEnc)");
    const call = src.slice(src.indexOf("await audit("));
    expect(call.slice(0, call.indexOf("});"))).not.toMatch(/input\.pan\b|input\.bankAccount\b|panEnc|bankAccountEnc/);
  });
});
