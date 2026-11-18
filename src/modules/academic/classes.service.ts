import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { classScopeWhere } from "./academic.policy";
import { assertClassCodeChangeAllowed, changedFields, nameKeyOf, staleError } from "./academic.rules";
import type { CreateClassInput, UpdateClassInput } from "./academic.schemas";

/**
 * Classes (master data, not session-scoped, never deleted). Writes: `academic.manage`; reads:
 * `academic.read` (ASSIGNED → only classes with a section the user is class teacher of).
 * Design: docs/PHASE_2_CLASSES_SECTIONS_DESIGN.md.
 */
const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });

/** Hard upper bound for list queries — a school has a few dozen classes. */
const MAX_CLASSES = 500;

export const CLASS_SELECT = {
  id: true,
  code: true,
  name: true,
  numericLevel: true,
  displayOrder: true,
  defaultSectionCapacity: true,
  isActive: true,
  version: true,
} satisfies Prisma.SchoolClassSelect;

export type ClassRow = Prisma.SchoolClassGetPayload<{ select: typeof CLASS_SELECT }>;
const CLASS_ORDER: Prisma.SchoolClassOrderByWithRelationInput[] = [{ displayOrder: "asc" }, { numericLevel: "asc" }, { name: "asc" }];

export async function listClasses(ctx: AuthContext, opts: { includeInactive?: boolean } = {}) {
  const scope = authorize(ctx, "academic.read");
  return prisma.schoolClass.findMany({
    where: { ...classScopeWhere(ctx, scope), ...(opts.includeInactive ? {} : { isActive: true }) },
    orderBy: CLASS_ORDER,
    take: MAX_CLASSES,
    select: { ...CLASS_SELECT, _count: { select: { sections: true } } },
  });
}

export async function getClass(ctx: AuthContext, id: string) {
  const scope = authorize(ctx, "academic.read");
  const row = await prisma.schoolClass.findFirst({ where: { id, ...classScopeWhere(ctx, scope) }, select: { ...CLASS_SELECT, _count: { select: { sections: true } } } });
  if (!row) throw new NotFoundError("Class not found.");
  return row;
}

function mapClassConflict(e: unknown, input: { code: string; name: string }): never {
  if (isUniqueViolation(e, "code")) throw new ConflictError(`A class with code ${input.code} already exists.`);
  if (isUniqueViolation(e, "nameKey")) throw new ConflictError(`A class named "${input.name}" already exists.`);
  throw e;
}

export async function createClass(ctx: AuthContext, input: CreateClassInput) {
  authorize(ctx, "academic.manage");
  const data = {
    code: input.code,
    name: input.name,
    nameKey: nameKeyOf(input.name),
    numericLevel: input.numericLevel,
    displayOrder: input.displayOrder,
    defaultSectionCapacity: input.defaultSectionCapacity,
  };
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.schoolClass.create({ data, select: CLASS_SELECT });
      const { nameKey: _k, ...after } = data;
      await audit(tx, actorOf(ctx), { action: "class.create", entityType: "SchoolClass", entityId: created.id, after: { ...after, isActive: true } });
      return created;
    });
  } catch (e) {
    mapClassConflict(e, input);
  }
}

/** Row lock on the class: serializes with section creation (which holds FOR SHARE) and other class writes. */
async function lockClass(tx: Tx, id: string): Promise<ClassRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_class WHERE id = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError("Class not found.");
  return tx.schoolClass.findUniqueOrThrow({ where: { id }, select: CLASS_SELECT });
}

export async function updateClass(ctx: AuthContext, input: UpdateClassInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const current = await lockClass(tx, input.id);
      if (current.version !== input.version) throw staleError("class");
      if (current.code !== input.code) {
        // Under the class lock: a section created concurrently has committed (it held FOR SHARE) and is counted.
        assertClassCodeChangeAllowed(current.code, input.code, await tx.section.count({ where: { classId: input.id } }));
      }
      const next = {
        code: input.code,
        name: input.name,
        numericLevel: input.numericLevel,
        displayOrder: input.displayOrder,
        defaultSectionCapacity: input.defaultSectionCapacity,
      };
      const diff = changedFields(current, next);
      if (Object.keys(diff.after).length === 0) return;
      const r = await tx.schoolClass.updateMany({
        where: { id: input.id, version: input.version },
        data: { ...next, nameKey: nameKeyOf(input.name), version: { increment: 1 } },
      });
      if (r.count !== 1) throw staleError("class");
      await audit(tx, actorOf(ctx), {
        action: "class.update",
        entityType: "SchoolClass",
        entityId: input.id,
        before: { ...diff.before, version: current.version },
        after: { ...diff.after, version: current.version + 1 },
      });
    });
  } catch (e) {
    mapClassConflict(e, input);
  }
}

/** Inactive classes get no new sections; existing sections are unaffected. Classes are never deleted. */
export async function setClassActive(ctx: AuthContext, id: string, version: number, active: boolean) {
  authorize(ctx, "academic.manage");
  await prisma.$transaction(async (tx) => {
    const current = await lockClass(tx, id);
    if (current.version !== version) throw staleError("class");
    if (current.isActive === active) return;
    const r = await tx.schoolClass.updateMany({ where: { id, version }, data: { isActive: active, version: { increment: 1 } } });
    if (r.count !== 1) throw staleError("class");
    await audit(tx, actorOf(ctx), { action: "class.status_change", entityType: "SchoolClass", entityId: id, before: { isActive: current.isActive }, after: { isActive: active } });
  });
}
