import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { employeeReadAccess } from "./hr.policy";
import { changedFields, masterNameKeyOf } from "./hr.rules";
import type { CreateDepartmentInput, CreateDesignationInput, SetMasterActiveInput, UpdateDepartmentInput, UpdateDesignationInput } from "./hr.schemas";

/**
 * Departments and designations (H9): master data, deactivated — never deleted. Reads: `employee.read` at ALL
 * (directory readers; a SELF grant for "My profile" doesn't reach school-wide lists — security review M3b L1);
 * writes: `employee.manage`.
 * A code (and a designation's staff type) is fixed once any employee uses it: codes appear in imports and
 * reports, and an employee's staff type must equal their designation's (H9).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
/** A school has a few dozen of each; the bound keeps every list query finite. */
const MAX_ROWS = 500;

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}
function mapErrors(e: unknown, what: "department" | "designation", input?: { code: string; name: string }): never {
  if (input && isUniqueViolation(e, "code")) throw new ConflictError(`A ${what} with code ${input.code} already exists.`);
  if (input && isUniqueViolation(e, "nameKey")) throw new ConflictError(`A ${what} named "${input.name}" already exists.`);
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}
const stale = (what: string) => new ConflictError(`This ${what} was changed by someone else. Reload the page and try again.`);

// ───────────────────────────── Departments ─────────────────────────────

export const DEPARTMENT_SELECT = { id: true, code: true, name: true, isActive: true, version: true } satisfies Prisma.DepartmentSelect;

export async function listDepartments(ctx: AuthContext, opts: { includeInactive?: boolean } = {}) {
  employeeReadAccess(ctx);
  return prisma.department.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: { ...DEPARTMENT_SELECT, _count: { select: { employees: { where: { deletedAt: null } } } } },
  });
}

export async function createDepartment(ctx: AuthContext, input: CreateDepartmentInput) {
  authorize(ctx, "employee.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.department.create({ data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name) }, select: DEPARTMENT_SELECT });
      await audit(tx, actorOf(ctx), { action: "department.create", entityType: "Department", entityId: created.id, after: { code: input.code, name: input.name, isActive: true } });
      return created;
    });
  } catch (e) {
    mapErrors(e, "department", input);
  }
}

async function lockDepartment(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM department WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Department not found.");
  return tx.department.findUniqueOrThrow({ where: { id }, select: DEPARTMENT_SELECT });
}

export async function updateDepartment(ctx: AuthContext, input: UpdateDepartmentInput) {
  authorize(ctx, "employee.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockDepartment(tx, input.id);
      if (current.version !== input.version) throw stale("department");
      if (current.code !== input.code && (await tx.employee.count({ where: { departmentId: input.id } })) > 0) {
        throw new ConflictError("The code can't change: employees already belong to this department.");
      }
      const diff = changedFields({ code: current.code, name: current.name }, { code: input.code, name: input.name });
      if (Object.keys(diff.after).length === 0) return;
      const r = await tx.department.updateMany({
        where: { id: input.id, version: input.version },
        data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale("department");
      await audit(tx, actorOf(ctx), {
        action: "department.update",
        entityType: "Department",
        entityId: input.id,
        before: { ...diff.before, version: current.version },
        after: { ...diff.after, version: current.version + 1 },
      });
    });
  } catch (e) {
    mapErrors(e, "department", input);
  }
}

/** Inactive departments can't receive new employees; existing employees are unaffected. Never deleted. */
export async function setDepartmentActive(ctx: AuthContext, input: SetMasterActiveInput) {
  authorize(ctx, "employee.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockDepartment(tx, input.id);
      if (current.version !== input.version) throw stale("department");
      if (current.isActive === input.active) return;
      const r = await tx.department.updateMany({ where: { id: input.id, version: input.version }, data: { isActive: input.active, version: { increment: 1 } } });
      if (r.count !== 1) throw stale("department");
      await audit(tx, actorOf(ctx), { action: "department.status_change", entityType: "Department", entityId: input.id, before: { isActive: current.isActive }, after: { isActive: input.active } });
    });
  } catch (e) {
    mapErrors(e, "department");
  }
}

// ───────────────────────────── Designations ─────────────────────────────

export const DESIGNATION_SELECT = { id: true, code: true, name: true, staffType: true, isActive: true, version: true } satisfies Prisma.DesignationSelect;

export async function listDesignations(ctx: AuthContext, opts: { includeInactive?: boolean } = {}) {
  employeeReadAccess(ctx);
  return prisma.designation.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ staffType: "asc" }, { name: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: { ...DESIGNATION_SELECT, _count: { select: { employees: { where: { deletedAt: null } } } } },
  });
}

export async function createDesignation(ctx: AuthContext, input: CreateDesignationInput) {
  authorize(ctx, "employee.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.designation.create({
        data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), staffType: input.staffType },
        select: DESIGNATION_SELECT,
      });
      await audit(tx, actorOf(ctx), {
        action: "designation.create",
        entityType: "Designation",
        entityId: created.id,
        after: { code: input.code, name: input.name, staffType: input.staffType, isActive: true },
      });
      return created;
    });
  } catch (e) {
    mapErrors(e, "designation", input);
  }
}

async function lockDesignation(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM designation WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Designation not found.");
  return tx.designation.findUniqueOrThrow({ where: { id }, select: DESIGNATION_SELECT });
}

export async function updateDesignation(ctx: AuthContext, input: UpdateDesignationInput) {
  authorize(ctx, "employee.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockDesignation(tx, input.id);
      if (current.version !== input.version) throw stale("designation");
      if (current.code !== input.code || current.staffType !== input.staffType) {
        // Under the designation lock: registration reads the designation FOR SHARE, so a concurrent
        // registration has either committed (counted here) or waits and then sees the new values.
        if ((await tx.employee.count({ where: { designationId: input.id } })) > 0) {
          throw new ConflictError(current.staffType !== input.staffType ? "The staff type can't change: employees already hold this designation." : "The code can't change: employees already hold this designation.");
        }
      }
      const diff = changedFields({ code: current.code, name: current.name, staffType: current.staffType }, { code: input.code, name: input.name, staffType: input.staffType });
      if (Object.keys(diff.after).length === 0) return;
      const r = await tx.designation.updateMany({
        where: { id: input.id, version: input.version },
        data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), staffType: input.staffType, version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale("designation");
      await audit(tx, actorOf(ctx), {
        action: "designation.update",
        entityType: "Designation",
        entityId: input.id,
        before: { ...diff.before, version: current.version },
        after: { ...diff.after, version: current.version + 1 },
      });
    });
  } catch (e) {
    mapErrors(e, "designation", input);
  }
}

export async function setDesignationActive(ctx: AuthContext, input: SetMasterActiveInput) {
  authorize(ctx, "employee.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockDesignation(tx, input.id);
      if (current.version !== input.version) throw stale("designation");
      if (current.isActive === input.active) return;
      const r = await tx.designation.updateMany({ where: { id: input.id, version: input.version }, data: { isActive: input.active, version: { increment: 1 } } });
      if (r.count !== 1) throw stale("designation");
      await audit(tx, actorOf(ctx), { action: "designation.status_change", entityType: "Designation", entityId: input.id, before: { isActive: current.isActive }, after: { isActive: input.active } });
    });
  } catch (e) {
    mapErrors(e, "designation");
  }
}
