import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { changedFields, masterNameKeyOf } from "@/modules/hr/hr.rules";
import type { CreateSubjectInput, SetSubjectActiveInput, UpdateSubjectInput } from "./subjects.schemas";

/**
 * Phase 4A-M2 — subjects (PHASE_4_PLAN.md AC2). School-defined master data; deactivated, never deleted.
 * Reads: `academic.read` (any scope — a subject list holds no student or staff data); writes: `academic.manage`.
 * The code and the kind are fixed once a class uses the subject (class_subject): codes appear in reports, and the kind
 * decides whether marks count towards results.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const MAX_ROWS = 500;

export const SUBJECT_SELECT = { id: true, code: true, name: true, kind: true, isActive: true, version: true } satisfies Prisma.SubjectSelect;

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}
function mapErrors(e: unknown, input?: { code: string; name: string }): never {
  if (input && isUniqueViolation(e, "code")) throw new ConflictError(`A subject with code ${input.code} already exists.`);
  if (input && isUniqueViolation(e, "nameKey")) throw new ConflictError(`A subject named "${input.name}" already exists.`);
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}
const stale = () => new ConflictError("This subject was changed by someone else. Reload the page and try again.");

async function lockSubject(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM subject WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Subject not found.");
  return tx.subject.findUniqueOrThrow({ where: { id }, select: SUBJECT_SELECT });
}

export async function listSubjects(ctx: AuthContext, opts: { includeInactive?: boolean } = {}) {
  authorize(ctx, "academic.read");
  return prisma.subject.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: { ...SUBJECT_SELECT, _count: { select: { classSubjects: true } } },
  });
}

export async function createSubject(ctx: AuthContext, input: CreateSubjectInput) {
  authorize(ctx, "academic.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.subject.create({
        data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), kind: input.kind },
        select: SUBJECT_SELECT,
      });
      await audit(tx, actorOf(ctx), {
        action: "subject.create",
        entityType: "Subject",
        entityId: created.id,
        after: { code: input.code, name: input.name, kind: input.kind, isActive: true },
      });
      return created;
    });
  } catch (e) {
    mapErrors(e, input);
  }
}

export async function updateSubject(ctx: AuthContext, input: UpdateSubjectInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockSubject(tx, input.id);
      if (current.version !== input.version) throw stale();
      if ((current.code !== input.code || current.kind !== input.kind) && (await tx.classSubject.count({ where: { subjectId: input.id } })) > 0) {
        throw new ConflictError("The code and type can't change: classes already study this subject.");
      }
      const diff = changedFields({ code: current.code, name: current.name, kind: current.kind }, { code: input.code, name: input.name, kind: input.kind });
      if (Object.keys(diff.after).length === 0) return;
      const r = await tx.subject.updateMany({
        where: { id: input.id, version: input.version },
        data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), kind: input.kind, version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), {
        action: "subject.update",
        entityType: "Subject",
        entityId: input.id,
        before: { ...diff.before, version: current.version },
        after: { ...diff.after, version: current.version + 1 },
      });
    });
  } catch (e) {
    mapErrors(e, input);
  }
}

/** An inactive subject can't be added to classes; existing class mappings are unaffected. Never deleted. */
export async function setSubjectActive(ctx: AuthContext, input: SetSubjectActiveInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockSubject(tx, input.id);
      if (current.version !== input.version) throw stale();
      if (current.isActive === input.active) return;
      const r = await tx.subject.updateMany({ where: { id: input.id, version: input.version }, data: { isActive: input.active, version: { increment: 1 } } });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), {
        action: "subject.status_change",
        entityType: "Subject",
        entityId: input.id,
        before: { isActive: current.isActive },
        after: { isActive: input.active },
      });
    });
  } catch (e) {
    mapErrors(e);
  }
}
