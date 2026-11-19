import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, authorizeAny, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { assertActorLinked, isOwnRecord } from "@/modules/hr/hr.policy";
import { lockPayroll } from "./payroll.tx";
import type { DecideSalaryInput, ProposeSalaryInput, SalaryRefInput } from "./salaries.schemas";

/**
 * Phase 3C-M2 — employee salaries, maker-checker (PHASE_3C_PLAN.md P7, ADR-037).
 *
 * - Propose: `salary.structure.manage` (HR). Decide: `payroll.approve` (Principal). Withdraw: the proposer or another
 *   `salary.structure.manage` holder, while pending.
 * - Separation of duties: the decider is never the proposer, and nobody proposes, decides or withdraws a salary of
 *   their OWN staff record — Super Admin included. A non–Super Admin actor must be linked to a staff record so the
 *   rule can be applied (KI-069).
 * - Never edited once decided: a change is a new proposal. One pending proposal per employee and one approved salary
 *   per employee and month (partial unique indexes). No proposal for a month whose payroll is already APPROVED / PAID.
 * - Salary amounts are visible only with `payroll.read`; audit rows never contain the amount or the decision note.
 * Lock order: employee (FOR SHARE) first everywhere; propose then locks salary_structure (SHARE) and inserts; decide
 * locks the employee_salary row (UPDATE) then salary_structure (SHARE). Structure writers lock only the structure and
 * count salaries — no writer waits on a salary row while holding a structure, so the orders can't deadlock.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const monthDate = (ym: string) => new Date(`${ym}-01T00:00:00.000Z`);
const ym = (d: Date) => d.toISOString().slice(0, 7);
const LEFT = new Set(["RESIGNED", "TERMINATED", "RETIRED"]);
const stale = () => new ConflictError("This salary proposal was changed by someone else. Reload the page and try again.");

function busy(e: unknown): never {
  if (isUniqueViolation(e)) throw new ConflictError("This employee already has a pending proposal, or an approved salary from that month. Reload the page and try again.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}
function assertNotOwn(ctx: AuthContext, employeeId: string, what: string) {
  if (isOwnRecord(ctx, employeeId)) throw new ForbiddenError(`You can't ${what} your own salary. Someone else must do it.`);
}

async function lockEmployee(tx: Tx, employeeId: string) {
  const [e] = await tx.$queryRaw<{ employment_status: string; joining_date: Date }[]>`
    SELECT employment_status::text AS employment_status, joining_date FROM employee WHERE id = ${employeeId} AND deleted_at IS NULL FOR SHARE`;
  if (!e) throw new NotFoundError("Employee not found.");
  return e;
}

/** Payroll months already approved or paid on or after `from` — their salaries are final (P5, P16). */
async function finalMonthFrom(tx: Tx, from: Date) {
  return tx.payrollRun.findFirst({ where: { month: { gte: from }, status: { in: ["APPROVED", "PAID"] } }, orderBy: { month: "asc" }, select: { month: true } });
}

// ───────────────────────────── Propose / decide / withdraw ─────────────────────────────

export async function proposeSalary(ctx: AuthContext, input: ProposeSalaryInput) {
  authorize(ctx, "salary.structure.manage");
  assertActorLinked(ctx);
  assertNotOwn(ctx, input.employeeId, "propose");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPayroll(tx); // KI-081: serialized with run prepare / approve
      const emp = await lockEmployee(tx, input.employeeId);
      if (LEFT.has(emp.employment_status)) throw new ConflictError("This employee has left the school.");
      const [structure] = await tx.$queryRaw<{ is_active: boolean }[]>`SELECT is_active FROM salary_structure WHERE id = ${input.structureId} FOR SHARE`;
      if (!structure) throw new NotFoundError("Salary structure not found.");
      if (!structure.is_active) throw new ValidationError("This salary structure is inactive.", [{ path: "structureId", message: "Choose an active structure." }]);
      // Review 3C-M2 H1: hold the structure's components too, so a concurrent change of a component's "prorated" flag
      // (which is refused once salaries use it) serializes with this proposal. Order: structure → components.
      await tx.$queryRaw`SELECT c.id FROM salary_component c JOIN salary_structure_item i ON i.component_id = c.id
        WHERE i.structure_id = ${input.structureId} ORDER BY c.id FOR SHARE OF c`;
      const from = monthDate(input.effectiveFrom);
      // Review 3C-M2 L3: not before the joining month, at most 12 months ahead.
      if (input.effectiveFrom < ym(emp.joining_date)) {
        throw new ValidationError(`The employee joined in ${ym(emp.joining_date)}; choose that month or later.`, [{ path: "effectiveFrom", message: "Before joining." }]);
      }
      const limit = new Date();
      limit.setUTCMonth(limit.getUTCMonth() + 12);
      if (input.effectiveFrom > ym(limit)) {
        throw new ValidationError("Choose a month within the next 12 months.", [{ path: "effectiveFrom", message: "Too far ahead." }]);
      }
      const final = await finalMonthFrom(tx, from);
      if (final) throw new ConflictError(`Payroll for ${ym(final.month)} is already approved. Choose a month after it; corrections to past months go in as arrears.`);
      const created = await tx.employeeSalary.create({
        data: { employeeId: input.employeeId, structureId: input.structureId, basic: input.basic, effectiveFrom: from, proposedById: ctx.userId },
        select: { id: true },
      });
      // The amount is sensitive (rule 10): never in the audit row.
      await audit(tx, actorOf(ctx), {
        action: "employee_salary.propose",
        entityType: "EmployeeSalary",
        entityId: created.id,
        after: { employeeId: input.employeeId, structureId: input.structureId, effectiveFrom: input.effectiveFrom, status: "PROPOSED" },
      });
      return created;
    });
  } catch (e) {
    return busy(e);
  }
}

async function lockProposal(tx: Tx, id: string) {
  const peek = await tx.employeeSalary.findUnique({ where: { id }, select: { employeeId: true } });
  if (!peek) throw new NotFoundError("Salary proposal not found.");
  const emp = await lockEmployee(tx, peek.employeeId);
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM employee_salary WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new NotFoundError("Salary proposal not found.");
  const cur = await tx.employeeSalary.findUniqueOrThrow({
    where: { id },
    select: { id: true, employeeId: true, structureId: true, effectiveFrom: true, status: true, proposedById: true, version: true },
  });
  return { ...cur, employmentStatus: emp.employment_status };
}

export async function decideSalary(ctx: AuthContext, input: DecideSalaryInput) {
  authorize(ctx, "payroll.approve");
  assertActorLinked(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      await lockPayroll(tx); // KI-081: serialized with run prepare / approve
      const cur = await lockProposal(tx, input.id);
      assertNotOwn(ctx, cur.employeeId, "decide");
      if (cur.proposedById === ctx.userId) throw new ForbiddenError("You proposed this salary, so someone else must decide it.");
      if (cur.version !== input.version) throw stale();
      if (cur.status !== "PROPOSED") throw new ConflictError("This proposal has already been decided or withdrawn.");
      if (input.decision === "APPROVE") {
        if (LEFT.has(cur.employmentStatus)) throw new ConflictError("This employee has left the school. Reject the proposal instead.");
        // Review 3C-M2 L2: the structure is locked and must still be active.
        const [st] = await tx.$queryRaw<{ is_active: boolean }[]>`SELECT is_active FROM salary_structure WHERE id = ${cur.structureId} FOR SHARE`;
        if (!st?.is_active) throw new ConflictError("This salary structure is no longer active. Reject the proposal; HR can propose with an active one.");
        const final = await finalMonthFrom(tx, cur.effectiveFrom);
        if (final) throw new ConflictError(`Payroll for ${ym(final.month)} is already approved. Reject this proposal; HR can propose it from a later month.`);
      }
      const r = await tx.employeeSalary.updateMany({
        where: { id: cur.id, version: cur.version, status: "PROPOSED" },
        data: {
          status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
          decidedById: ctx.userId,
          decidedAt: new Date(),
          decisionNote: input.note === "" ? null : input.note,
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), {
        action: input.decision === "APPROVE" ? "employee_salary.approve" : "employee_salary.reject",
        entityType: "EmployeeSalary",
        entityId: cur.id,
        before: { status: "PROPOSED" },
        after: { status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED", employeeId: cur.employeeId, effectiveFrom: ym(cur.effectiveFrom) },
      });
    });
  } catch (e) {
    busy(e);
  }
}

export async function withdrawSalary(ctx: AuthContext, input: SalaryRefInput) {
  authorize(ctx, "salary.structure.manage");
  assertActorLinked(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      await lockPayroll(tx); // KI-081: serialized with run prepare / approve
      const cur = await lockProposal(tx, input.id);
      assertNotOwn(ctx, cur.employeeId, "withdraw");
      if (cur.version !== input.version) throw stale();
      if (cur.status !== "PROPOSED") throw new ConflictError("Only a pending proposal can be withdrawn.");
      const r = await tx.employeeSalary.updateMany({ where: { id: cur.id, version: cur.version }, data: { status: "WITHDRAWN", version: { increment: 1 } } });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), { action: "employee_salary.withdraw", entityType: "EmployeeSalary", entityId: cur.id, before: { status: "PROPOSED" }, after: { status: "WITHDRAWN", employeeId: cur.employeeId } });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── Reads (payroll.read) ─────────────────────────────

function assertSalaryReader(ctx: AuthContext) {
  authorizeAny(ctx, ["payroll.read", "payroll.approve", "salary.structure.manage"]);
  if (!hasPermission(ctx, "payroll.read")) throw new ForbiddenError("Salary amounts need the payroll read permission.");
}

const SALARY_SELECT = {
  id: true,
  basic: true,
  effectiveFrom: true,
  status: true,
  version: true,
  decisionNote: true,
  decidedAt: true,
  createdAt: true,
  structure: { select: { id: true, name: true } },
  proposedBy: { select: { id: true, displayName: true } },
  decidedBy: { select: { displayName: true } },
} as const;

/** Staff picker for payroll (directory fields only): employees on the rolls, newest joiners first among equals. */
export async function listPayrollEmployees(ctx: AuthContext, q: string) {
  assertSalaryReader(ctx);
  const term = q.trim().slice(0, 60);
  return prisma.employee.findMany({
    where: {
      deletedAt: null,
      employmentStatus: { notIn: ["RESIGNED", "TERMINATED", "RETIRED"] },
      ...(term ? { OR: [{ fullName: { contains: term, mode: "insensitive" as const } }, { employeeCode: { contains: term.toUpperCase() } }] } : {}),
    },
    orderBy: [{ fullName: "asc" }, { id: "asc" }],
    take: 50,
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      designation: { select: { name: true } },
      salaries: { where: { status: { in: ["APPROVED", "PROPOSED"] } }, orderBy: { effectiveFrom: "desc" }, take: 2, select: { status: true, effectiveFrom: true } },
    },
  });
}

export async function getEmployeeSalaries(ctx: AuthContext, employeeId: string) {
  assertSalaryReader(ctx);
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: { id: true, employeeCode: true, fullName: true, employmentStatus: true, designation: { select: { name: true } }, department: { select: { name: true } } },
  });
  if (!emp) throw new NotFoundError("Employee not found.");
  const history = await prisma.employeeSalary.findMany({ where: { employeeId }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }], take: 100, select: SALARY_SELECT });
  return { employee: emp, own: isOwnRecord(ctx, employeeId), history };
}

/** Approval queue: pending proposals of OTHER staff that the caller didn't propose. */
export async function listPendingSalaries(ctx: AuthContext) {
  authorize(ctx, "payroll.approve");
  assertSalaryReader(ctx);
  const own = typeof ctx.employeeId === "string" && ctx.employeeId !== "" ? ctx.employeeId : null;
  return prisma.employeeSalary.findMany({
    where: {
      status: "PROPOSED",
      employee: { deletedAt: null },
      ...(own ? { employeeId: { not: own } } : {}),
      OR: [{ proposedById: null }, { proposedById: { not: ctx.userId } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { ...SALARY_SELECT, employee: { select: { id: true, employeeCode: true, fullName: true } } },
  });
}
