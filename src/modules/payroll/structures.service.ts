import Decimal from "decimal.js";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, authorizeAny, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { changedFields, masterNameKeyOf } from "@/modules/hr/hr.rules";
import type { CreateComponentInput, CreateStructureInput, SetActiveInput, UpdateComponentInput, UpdateStructureInput } from "./structures.schemas";

/**
 * Phase 3C-M2 — salary components and salary structures (PHASE_3C_PLAN.md P1, P2, ADR-037).
 *
 * - School-defined only: nothing is seeded, and there is no statutory logic (PF, ESI, professional tax are ordinary
 *   deduction components with the school's own values).
 * - Reads: `payroll.read` or `salary.structure.manage`. Writes: `salary.structure.manage`.
 * - A component's code, kind and calculation are fixed once a structure uses it (they decide how slips are computed).
 * - A structure's items can change; slips already prepared keep their snapshot (ADR-037), and each change is audited
 *   with the items before and after. Percentages of basic are 0–100.
 * Never deleted — deactivated (an inactive component can't be added to structures; an inactive structure can't be
 * given to employees).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const MAX_ROWS = 200;
const stale = (what: string) => new ConflictError(`This ${what} was changed by someone else. Reload the page and try again.`);

function mapErrors(e: unknown, what: "component" | "structure", input?: { code?: string; name: string }): never {
  if (input?.code && isUniqueViolation(e, "code")) throw new ConflictError(`A ${what} with code ${input.code} already exists.`);
  if (input && isUniqueViolation(e, "nameKey")) throw new ConflictError(`A ${what} named "${input.name}" already exists.`);
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}
async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}
const readAccess = (ctx: AuthContext) => authorizeAny(ctx, ["payroll.read", "salary.structure.manage"]);

// ───────────────────────────── Components ─────────────────────────────

export const COMPONENT_SELECT = { id: true, code: true, name: true, kind: true, calc: true, prorated: true, isActive: true, version: true } satisfies Prisma.SalaryComponentSelect;

export async function listComponents(ctx: AuthContext, opts: { includeInactive?: boolean } = {}) {
  readAccess(ctx);
  return prisma.salaryComponent.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: { ...COMPONENT_SELECT, _count: { select: { items: true } } },
  });
}

export async function createComponent(ctx: AuthContext, input: CreateComponentInput) {
  authorize(ctx, "salary.structure.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const c = await tx.salaryComponent.create({
        data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), kind: input.kind, calc: input.calc, prorated: input.prorated },
        select: COMPONENT_SELECT,
      });
      await audit(tx, actorOf(ctx), { action: "salary_component.create", entityType: "SalaryComponent", entityId: c.id, after: { ...input, isActive: true } });
      return c;
    });
  } catch (e) {
    mapErrors(e, "component", input);
  }
}

async function lockComponent(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM salary_component WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Component not found.");
  return tx.salaryComponent.findUniqueOrThrow({ where: { id }, select: { ...COMPONENT_SELECT, _count: { select: { items: true } } } });
}

export async function updateComponent(ctx: AuthContext, input: UpdateComponentInput) {
  authorize(ctx, "salary.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const cur = await lockComponent(tx, input.id);
      if (cur.version !== input.version) throw stale("component");
      if (cur._count.items > 0 && (cur.code !== input.code || cur.kind !== input.kind || cur.calc !== input.calc)) {
        throw new ConflictError("The code, type and calculation can't change: salary structures already use this component.");
      }
      const diff = changedFields(
        { code: cur.code, name: cur.name, kind: cur.kind, calc: cur.calc, prorated: cur.prorated },
        { code: input.code, name: input.name, kind: input.kind, calc: input.calc, prorated: input.prorated },
      );
      if (Object.keys(diff.after).length === 0) return;
      const r = await tx.salaryComponent.updateMany({
        where: { id: input.id, version: input.version },
        data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), kind: input.kind, calc: input.calc, prorated: input.prorated, version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale("component");
      await audit(tx, actorOf(ctx), { action: "salary_component.update", entityType: "SalaryComponent", entityId: input.id, before: diff.before, after: diff.after });
    });
  } catch (e) {
    mapErrors(e, "component", input);
  }
}

export async function setComponentActive(ctx: AuthContext, input: SetActiveInput) {
  authorize(ctx, "salary.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const cur = await lockComponent(tx, input.id);
      if (cur.version !== input.version) throw stale("component");
      if (cur.isActive === input.active) return;
      await tx.salaryComponent.update({ where: { id: input.id }, data: { isActive: input.active, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "salary_component.status_change", entityType: "SalaryComponent", entityId: input.id, before: { isActive: cur.isActive }, after: { isActive: input.active } });
    });
  } catch (e) {
    mapErrors(e, "component");
  }
}

// ───────────────────────────── Structures ─────────────────────────────

export async function listStructures(ctx: AuthContext, opts: { includeInactive?: boolean } = {}) {
  readAccess(ctx);
  return prisma.salaryStructure.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: {
      id: true,
      name: true,
      isActive: true,
      version: true,
      _count: { select: { salaries: { where: { status: "APPROVED" } } } },
      items: {
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: { value: true, component: { select: { id: true, code: true, name: true, kind: true, calc: true, prorated: true, isActive: true } } },
      },
    },
  });
}

/** Items are validated against their components under FOR SHARE: active, and PERCENT_OF_BASIC values ≤ 100. */
async function checkedItems(tx: Tx, items: CreateStructureInput["items"]) {
  if (items.length === 0) return [];
  const ids = [...items.map((i) => i.componentId)].sort();
  const comps = await tx.$queryRaw<{ id: string; code: string; calc: string; is_active: boolean }[]>`
    SELECT id, code, calc::text AS calc, is_active FROM salary_component WHERE id = ANY(${ids}) ORDER BY id FOR SHARE`;
  if (comps.length !== ids.length) throw new NotFoundError("Component not found. Reload the page and try again.");
  const byId = new Map(comps.map((c) => [c.id, c]));
  return items.map((it, i) => {
    const c = byId.get(it.componentId)!;
    if (!c.is_active) throw new ValidationError(`Component ${c.code} is inactive.`, [{ path: "items", message: "Inactive components can't be added." }]);
    if (c.calc === "PERCENT_OF_BASIC" && new Decimal(it.value).gt(100)) {
      throw new ValidationError(`${c.code}: a percentage of basic can't exceed 100.`, [{ path: "items", message: "Percent must be 0–100." }]);
    }
    return { componentId: it.componentId, value: it.value, sortOrder: i, code: c.code };
  });
}

export async function createStructure(ctx: AuthContext, input: CreateStructureInput) {
  authorize(ctx, "salary.structure.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const items = await checkedItems(tx, input.items);
      const s = await tx.salaryStructure.create({
        data: { name: input.name, nameKey: masterNameKeyOf(input.name), items: { create: items.map(({ componentId, value, sortOrder }) => ({ componentId, value, sortOrder })) } },
        select: { id: true, name: true },
      });
      await audit(tx, actorOf(ctx), {
        action: "salary_structure.create",
        entityType: "SalaryStructure",
        entityId: s.id,
        after: { name: input.name, items: items.map((i) => ({ code: i.code, value: i.value })) },
      });
      return s;
    });
  } catch (e) {
    mapErrors(e, "structure", input);
  }
}

export async function updateStructure(ctx: AuthContext, input: UpdateStructureInput) {
  authorize(ctx, "salary.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM salary_structure WHERE id = ${input.id} FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundError("Structure not found.");
      const cur = await tx.salaryStructure.findUniqueOrThrow({
        where: { id: input.id },
        select: { name: true, version: true, items: { orderBy: { sortOrder: "asc" }, select: { componentId: true, value: true, component: { select: { code: true } } } } },
      });
      if (cur.version !== input.version) throw stale("structure");
      const items = await checkedItems(tx, input.items);
      const before = cur.items.map((i) => ({ code: i.component.code, value: i.value.toFixed(2) }));
      const after = items.map((i) => ({ code: i.code, value: new Decimal(i.value).toFixed(2) }));
      if (cur.name === input.name && JSON.stringify(before) === JSON.stringify(after)) return;
      await tx.salaryStructureItem.deleteMany({ where: { structureId: input.id } });
      if (items.length) await tx.salaryStructureItem.createMany({ data: items.map(({ componentId, value, sortOrder }) => ({ structureId: input.id, componentId, value, sortOrder })) });
      const r = await tx.salaryStructure.updateMany({ where: { id: input.id, version: input.version }, data: { name: input.name, nameKey: masterNameKeyOf(input.name), version: { increment: 1 } } });
      if (r.count !== 1) throw stale("structure");
      await audit(tx, actorOf(ctx), { action: "salary_structure.update", entityType: "SalaryStructure", entityId: input.id, before: { name: cur.name, items: before }, after: { name: input.name, items: after } });
    });
  } catch (e) {
    mapErrors(e, "structure", input);
  }
}

export async function setStructureActive(ctx: AuthContext, input: SetActiveInput) {
  authorize(ctx, "salary.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const rows = await tx.$queryRaw<{ is_active: boolean; version: number }[]>`SELECT is_active, version FROM salary_structure WHERE id = ${input.id} FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundError("Structure not found.");
      if (rows[0].version !== input.version) throw stale("structure");
      if (rows[0].is_active === input.active) return;
      await tx.salaryStructure.update({ where: { id: input.id }, data: { isActive: input.active, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "salary_structure.status_change", entityType: "SalaryStructure", entityId: input.id, before: { isActive: rows[0].is_active }, after: { isActive: input.active } });
    });
  } catch (e) {
    mapErrors(e, "structure");
  }
}
