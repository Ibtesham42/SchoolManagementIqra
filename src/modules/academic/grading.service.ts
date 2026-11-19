import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { masterNameKeyOf } from "@/modules/hr/hr.rules";
import { CBSE_STYLE_8_POINT, GradeCalcError, validateScale, type GradeBand } from "./grade-calc";
import type { CreateScaleInput, SetScaleActiveInput, UpdateScaleInput } from "./grading.schemas";

/**
 * Phase 4B-M2 — grading scales (PHASE_4_PLAN.md AC8). Grading is data, not code.
 * - Manage: `exam.manage` (School Admin, Principal). Read: `exam.manage` or `academic.read` at ALL.
 * - Bands are validated by grade-calc.validateScale (first band at 0 %, strictly increasing, unique grades).
 * - The CBSE-style 8-point template creates an ordinary, editable scale on request — never automatically.
 * - A scale used by any exam beyond DRAFT is frozen (its bands decide published grades); deactivate instead.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const stale = () => new ConflictError("This grading scale was changed by someone else. Reload the page and try again.");
const busy = (e: unknown, name?: string): never => {
  if (isUniqueViolation(e, "nameKey")) throw new ConflictError(`A grading scale named "${name ?? "that"}" already exists.`);
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

function assertRead(ctx: AuthContext) {
  if (hasPermission(ctx, "exam.manage")) return;
  if (authorize(ctx, "academic.read") !== "ALL") throw new ForbiddenError();
}

function checked(bands: CreateScaleInput["bands"]): GradeBand[] {
  try {
    return validateScale(bands);
  } catch (e) {
    if (e instanceof GradeCalcError) throw new ValidationError(e.message, [{ path: "bands", message: e.message }]);
    throw e;
  }
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

export async function listScales(ctx: AuthContext) {
  assertRead(ctx);
  return prisma.gradeScale.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    take: 50,
    select: {
      id: true,
      name: true,
      isActive: true,
      version: true,
      bands: { orderBy: { minPercent: "asc" }, select: { minPercent: true, grade: true, gradePoint: true, remark: true } },
      _count: { select: { examinations: { where: { status: { not: "DRAFT" } } } } },
    },
  });
}

async function createWith(ctx: AuthContext, name: string, bands: GradeBand[], action: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      const s = await tx.gradeScale.create({
        data: {
          name,
          nameKey: masterNameKeyOf(name),
          bands: { create: bands.map((b) => ({ minPercent: b.minPercent, grade: b.grade.trim(), gradePoint: b.gradePoint, remark: b.remark })) },
        },
        select: { id: true, name: true },
      });
      await audit(tx, actorOf(ctx), { action, entityType: "GradeScale", entityId: s.id, after: { name, bands: bands.map((b) => `${b.minPercent}:${b.grade}`) } });
      return s;
    });
  } catch (e) {
    return busy(e, name);
  }
}

export async function createScale(ctx: AuthContext, input: CreateScaleInput) {
  authorize(ctx, "exam.manage");
  return createWith(ctx, input.name, checked(input.bands), "grade_scale.create");
}

/** AC8 template: the school asked for it; it's an ordinary scale they can edit until an exam uses it. */
export async function createCbseStyleScale(ctx: AuthContext) {
  authorize(ctx, "exam.manage");
  return createWith(ctx, "CBSE-style 8-point", validateScale(CBSE_STYLE_8_POINT), "grade_scale.create_from_template");
}

export async function updateScale(ctx: AuthContext, input: UpdateScaleInput) {
  authorize(ctx, "exam.manage");
  const bands = checked(input.bands);
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const [row] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM grade_scale WHERE id = ${input.id} FOR UPDATE`;
      if (!row) throw new NotFoundError("Grading scale not found.");
      if (row.version !== input.version) throw stale();
      const inUse = await tx.examination.count({ where: { gradeScaleId: input.id, status: { not: "DRAFT" } } });
      const current = await tx.gradeBand.findMany({ where: { scaleId: input.id }, orderBy: { minPercent: "asc" }, select: { minPercent: true, grade: true, gradePoint: true, remark: true } });
      const sig = (b: { minPercent: unknown; grade: string; gradePoint: unknown; remark: string | null }) => `${Number(b.minPercent)}|${b.grade}|${b.gradePoint === null ? "" : Number(b.gradePoint)}|${b.remark ?? ""}`;
      const bandsChanged = current.map(sig).join(";") !== bands.map(sig).join(";");
      if (bandsChanged && inUse > 0) throw new ConflictError("Exams already use this scale, so its bands are fixed. Create a new scale for future exams.");
      if (bandsChanged) {
        await tx.gradeBand.deleteMany({ where: { scaleId: input.id } });
        await tx.gradeBand.createMany({ data: bands.map((b) => ({ scaleId: input.id, minPercent: b.minPercent, grade: b.grade.trim(), gradePoint: b.gradePoint, remark: b.remark })) });
      }
      await tx.gradeScale.update({ where: { id: input.id }, data: { name: input.name, nameKey: masterNameKeyOf(input.name), version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "grade_scale.update", entityType: "GradeScale", entityId: input.id, after: { name: input.name, bandsChanged, bands: bandsChanged ? bands.map((b) => `${b.minPercent}:${b.grade}`) : undefined } });
    });
  } catch (e) {
    busy(e, input.name);
  }
}

export async function setScaleActive(ctx: AuthContext, input: SetScaleActiveInput) {
  authorize(ctx, "exam.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const [row] = await tx.$queryRaw<{ version: number; is_active: boolean }[]>`SELECT version, is_active FROM grade_scale WHERE id = ${input.id} FOR UPDATE`;
      if (!row) throw new NotFoundError("Grading scale not found.");
      if (row.version !== input.version) throw stale();
      if (row.is_active === input.active) return;
      await tx.gradeScale.update({ where: { id: input.id }, data: { isActive: input.active, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "grade_scale.status_change", entityType: "GradeScale", entityId: input.id, before: { isActive: row.is_active }, after: { isActive: input.active } });
    });
  } catch (e) {
    busy(e);
  }
}

/** For screens: whether the caller manages scales (exam.manage) and may read them (academic.read ALL). */
export function gradingAccess(ctx: AuthContext) {
  const manage = hasPermission(ctx, "exam.manage");
  const read = manage || (hasPermission(ctx, "academic.read") && scopeFor(ctx, "academic.read") === "ALL");
  return { manage, read };
}
