import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 3C (P8) PAN / bank details against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped
 * without TEST_DATABASE_URL). Ciphertext really stored (not plaintext), HMAC uniqueness, CHECK pairs, masking, versions,
 * audit without values. Synthetic, invalid-for-real-use values only.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/hr/bank-details.service")),
  ...(await import("@/modules/hr/bank-details.schemas")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("PAN / bank details (integration)", () => {
  const run = `bd${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx, empA: string, empB: string;
  const PAN = "AAAAA9999A"; // synthetic
  const ACC = "000000000123456"; // synthetic
  const form = (employeeId: string, version: number, over: Record<string, string> = {}) =>
    m.updateBankDetailsSchema.parse({ employeeId, version: String(version), pan: "", bankAccount: "", bankIfsc: "", bankAccountName: "", removePan: "", removeBank: "", ...over });

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const h = await user("hr", "HR_MANAGER");
    await linkTeachingEmployee(m.prisma, tag, h.id, { staffType: "NON_TEACHING" });
    empA = await linkTeachingEmployee(m.prisma, tag, (await user("a", "TEACHER")).id);
    empB = await linkTeachingEmployee(m.prisma, tag, (await user("b", "TEACHER")).id);
    hr = (await m.validateSessionToken((await m.createSession(h.id, { long: false })).token))!;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 120_000);

  it("stores ciphertext + HMAC (never plaintext), shows masked values, audits change flags only", async () => {
    const v = (await m.getBankDetails(hr, empA)).version;
    await m.updateBankDetails(hr, form(empA, v, { pan: PAN, bankAccount: ACC, bankIfsc: "SBIN0001234", bankAccountName: "Synthetic Name" }));
    const raw = await m.prisma.employee.findUniqueOrThrow({ where: { id: empA }, select: { panEnc: true, panHmac: true, bankAccountEnc: true } });
    expect(raw.panEnc).toMatch(/^v\d+\./);
    expect(raw.panEnc).not.toContain(PAN);
    expect(raw.bankAccountEnc).not.toContain(ACC);
    expect(raw.panHmac).toMatch(/^[0-9a-f]{64}$/);
    const shown = await m.getBankDetails(hr, empA);
    expect(shown).toMatchObject({ pan: "XXXXXX999A", bankAccount: "XXXXXXXXXXX3456", bankIfsc: "SBIN0001234" });
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "employee.bank_details_update", entityId: empA }, orderBy: { at: "desc" } });
    expect(JSON.stringify(log)).not.toContain(PAN);
    expect(JSON.stringify(log)).not.toContain(ACC);
    expect(log.after).toMatchObject({ panChanged: true, bankAccountChanged: true });
  });

  it("the same PAN can't be recorded for two employees; a stale version is refused; remove clears both halves", async () => {
    const vb = (await m.getBankDetails(hr, empB)).version;
    await expect(m.updateBankDetails(hr, form(empB, vb, { pan: PAN }))).rejects.toThrow(/another employee/);
    await expect(m.updateBankDetails(hr, form(empA, 1, { bankIfsc: "HDFC0000001" }))).rejects.toThrow(/changed by someone else/);
    const va = (await m.getBankDetails(hr, empA)).version;
    await m.updateBankDetails(hr, form(empA, va, { removePan: "on", removeBank: "on" }));
    const raw = await m.prisma.employee.findUniqueOrThrow({ where: { id: empA }, select: { panEnc: true, panHmac: true, bankAccountEnc: true, bankAccountHmac: true, bankIfsc: true } });
    expect(raw).toEqual({ panEnc: null, panHmac: null, bankAccountEnc: null, bankAccountHmac: null, bankIfsc: null });
  });

  it("review L1 / L2: bank details stay complete; the same account on two staff is allowed but flagged", async () => {
    const vb = (await m.getBankDetails(hr, empB)).version;
    await expect(m.updateBankDetails(hr, form(empB, vb, { bankIfsc: "SBIN0001234" }))).rejects.toThrow(/must be complete/);
    await m.updateBankDetails(hr, form(empB, vb, { bankAccount: ACC, bankIfsc: "SBIN0001234", bankAccountName: "Synthetic Joint" }));
    const va = (await m.getBankDetails(hr, empA)).version;
    await m.updateBankDetails(hr, form(empA, va, { bankAccount: ACC, bankIfsc: "SBIN0001234", bankAccountName: "Synthetic Joint" }));
    expect((await m.getBankDetails(hr, empA)).sharedWith).toBe(1);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "employee.bank_details_update", entityId: empA }, orderBy: { at: "desc" } });
    expect(log.after).toMatchObject({ sharedAccount: true });
  });

  it("the database refuses half a pair and a malformed IFSC (past the service)", async () => {
    await expect(m.prisma.employee.update({ where: { id: empB }, data: { panEnc: "v1.x" } })).rejects.toThrow();
    await expect(m.prisma.employee.update({ where: { id: empB }, data: { bankIfsc: "BAD" } })).rejects.toThrow();
  });
});
