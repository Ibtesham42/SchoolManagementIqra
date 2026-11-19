import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 3C-M2 salary components and structures against real Postgres (Neon Test branch only, behind the S-05 target
 * guard; skipped without TEST_DATABASE_URL). Real uniqueness, locks, versions, CHECKs and audit rows. Synthetic data;
 * removed in afterAll except audit rows (append-only, S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/payroll/structures.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("payroll components and structures (integration)", () => {
  const run = `ps${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx, principal: Ctx;

  async function ctxFor(roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${roleKey.toLowerCase()}`, displayName: `Synthetic ${roleKey}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [hr, principal] = [await ctxFor("HR_MANAGER"), await ctxFor("PRINCIPAL")];
  }, 120_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const structures = await prisma.salaryStructure.findMany({ where: { nameKey: { startsWith: run } }, select: { id: true } });
    await prisma.salaryStructureItem.deleteMany({ where: { structureId: { in: structures.map((s) => s.id) } } });
    await prisma.salaryStructure.deleteMany({ where: { id: { in: structures.map((s) => s.id) } } });
    await prisma.salaryComponent.deleteMany({ where: { code: { startsWith: tag } } });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 120_000);

  it("components: create, refuse duplicates, lock code / type / calculation once a structure uses them", async () => {
    const hra = (await m.createComponent(hr, { code: `${tag}HRA`, name: `${run} HRA`, kind: "EARNING", calc: "FIXED", prorated: true }))!;
    const pf = (await m.createComponent(hr, { code: `${tag}PF`, name: `${run} PF`, kind: "DEDUCTION", calc: "PERCENT_OF_BASIC", prorated: true }))!;
    await expect(m.createComponent(hr, { code: `${tag}HRA`, name: `${run} other`, kind: "EARNING", calc: "FIXED", prorated: true })).rejects.toBeInstanceOf(m.ConflictError);
    await m.createStructure(hr, { name: `${run} Teaching`, items: [{ componentId: hra.id, value: "5000" }, { componentId: pf.id, value: "12" }] });
    await expect(m.updateComponent(hr, { id: pf.id, version: 1, code: `${tag}PF`, name: `${run} PF`, kind: "DEDUCTION", calc: "FIXED", prorated: true })).rejects.toThrow(/can't change/);
    await m.updateComponent(hr, { id: pf.id, version: 1, code: `${tag}PF`, name: `${run} Provident fund`, kind: "DEDUCTION", calc: "PERCENT_OF_BASIC", prorated: false });
    expect((await m.listComponents(hr)).find((c) => c.id === pf.id)).toMatchObject({ name: `${run} Provident fund`, prorated: false, version: 2 });
  });

  it("structures: percentages above 100 and inactive components are refused; edits audited with items before and after", async () => {
    const comps = await m.listComponents(hr);
    const pf = comps.find((c) => c.code === `${tag}PF`)!;
    const hra = comps.find((c) => c.code === `${tag}HRA`)!;
    await expect(m.createStructure(hr, { name: `${run} Bad`, items: [{ componentId: pf.id, value: "120" }] })).rejects.toThrow(/exceed 100/);
    const s = (await m.listStructures(hr)).find((x) => x.name === `${run} Teaching`)!;
    await m.updateStructure(hr, { id: s.id, version: s.version, name: `${run} Teaching`, items: [{ componentId: hra.id, value: "5500" }] });
    await expect(m.updateStructure(hr, { id: s.id, version: s.version, name: `${run} Teaching`, items: [] })).rejects.toThrow(/changed by someone else/);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "salary_structure.update", entityId: s.id }, orderBy: { at: "desc" } });
    expect(log.before).toMatchObject({ items: [{ code: `${tag}HRA`, value: "5000.00" }, { code: `${tag}PF`, value: "12.00" }] });
    expect(log.after).toMatchObject({ items: [{ code: `${tag}HRA`, value: "5500.00" }] });
    await m.setComponentActive(hr, { id: pf.id, version: pf.version, active: false });
    await expect(m.createStructure(hr, { name: `${run} Old`, items: [{ componentId: pf.id, value: "10" }] })).rejects.toThrow(/inactive/);
  });

  it("review H1: a structure used by a pending / approved salary is frozen (items, and components' prorated flag); copy-and-edit works", async () => {
    const hra = (await m.listComponents(hr)).find((c) => c.code === `${tag}HRA`)!;
    const s = (await m.listStructures(hr)).find((x) => x.name === `${run} Teaching`)!;
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "TEACHER" } });
    const tu = await m.prisma.user.create({ data: { username: `${run}-t`, displayName: "Synthetic t", passwordHash: "x", roles: { create: { roleId: role.id } } } });
    const empId = await linkTeachingEmployee(m.prisma, tag, tu.id);
    const sal = await m.prisma.employeeSalary.create({ data: { employeeId: empId, structureId: s.id, basic: 1, effectiveFrom: new Date("2999-01-01"), status: "PROPOSED" } });
    try {
      await expect(m.updateStructure(hr, { id: s.id, version: s.version, name: s.name, items: [{ componentId: hra.id, value: "99999" }] })).rejects.toThrow(/components are fixed/);
      await m.updateStructure(hr, { id: s.id, version: s.version, name: `${run} Teaching staff`, items: s.items.map((i) => ({ componentId: i.component.id, value: i.value.toFixed(2) })) }); // name only
      await expect(m.updateComponent(hr, { id: hra.id, version: hra.version, code: hra.code, name: hra.name, kind: hra.kind, calc: hra.calc, prorated: !hra.prorated })).rejects.toThrow(/unpaid days/);
      const copy = await m.copyStructure(hr, { id: s.id, name: `${run} Teaching v2` });
      const fresh = (await m.listStructures(hr)).find((x) => x.id === copy!.id)!;
      await m.updateStructure(hr, { id: fresh.id, version: fresh.version, name: fresh.name, items: [{ componentId: hra.id, value: "6000" }] });
    } finally {
      await m.prisma.employeeSalary.delete({ where: { id: sal.id } });
    }
  });

  it("the Principal reads but can't change; database CHECKs refuse negative values past the service", async () => {
    expect((await m.listStructures(principal)).some((s) => s.name.startsWith(`${run} Teaching`))).toBe(true);
    await expect(m.createComponent(principal, { code: `${tag}X`, name: `${run} X`, kind: "EARNING", calc: "FIXED", prorated: true })).rejects.toBeInstanceOf(m.ForbiddenError);
    const s = (await m.listStructures(hr)).find((x) => x.name.startsWith(`${run} Teaching`))!;
    const hra = (await m.listComponents(hr)).find((c) => c.code === `${tag}HRA`)!;
    await expect(m.prisma.salaryStructureItem.update({ where: { structureId_componentId: { structureId: s.id, componentId: hra.id } }, data: { value: -1 } })).rejects.toThrow();
  });
});
