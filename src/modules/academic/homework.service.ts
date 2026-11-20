import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { ALLOCATABLE_TEACHER_EMPLOYEE } from "@/modules/hr/hr.tx";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { assertSessionWritable } from "./academic.rules";
import { lockSessionShared } from "./academic.tx";
import type { CreateHomeworkInput, HomeworkRefInput, UpdateHomeworkInput } from "./homework.schemas";

/**
 * Phase 4C-M2 — homework (PHASE_4_PLAN.md AC17; owner decision 2026-11-20: `homework.manage`, text first).
 *
 * - Post / edit / remove: `homework.manage` ALL (School Admin) → any section; ASSIGNED (Teacher, Class Teacher) → only
 *   the subject the teacher is ALLOCATED to in that section (TeacherAllocation → ctx.employeeId, still an active teaching
 *   employee), in a session that isn't CLOSED. Same allocation rule as marks entry.
 * - Read a section's homework: whoever may manage one of its subjects, `academic.read` ALL, or the section's class
 *   teacher (`academic.read` ASSIGNED). Others get NotFound. Parents / students: no portal yet (AC20).
 * - The due date is today or later (school time zone) and inside the session. Removal is a soft delete.
 * Lock order: academic_session FOR SHARE → section FOR SHARE → teacher_allocation FOR SHARE → homework FOR UPDATE.
 * Audit rows carry ids and dates, never the text.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};
type Db = Tx | typeof prisma;
const hasEmployee = (ctx: AuthContext): ctx is AuthContext & { employeeId: string } => typeof ctx.employeeId === "string" && ctx.employeeId !== "";
const manageScope = (ctx: AuthContext) => (hasPermission(ctx, "homework.manage") ? scopeFor(ctx, "homework.manage") : null);

async function sectionFacts(db: Db, sectionId: string) {
  const s = await db.section.findUnique({
    where: { id: sectionId },
    select: { id: true, code: true, classId: true, classTeacherId: true, academicSessionId: true, academicSession: { select: { name: true, status: true, startDate: true, endDate: true } } },
  });
  if (!s) throw new NotFoundError("Section not found.");
  return s;
}
type SectionFacts = Awaited<ReturnType<typeof sectionFacts>>;

/** Class subjects of the section the caller may post homework for. */
async function manageableSubjects(db: Db, ctx: AuthContext, s: SectionFacts): Promise<Set<string>> {
  const scope = manageScope(ctx);
  if (!scope || s.academicSession.status === "CLOSED") return new Set();
  if (scope === "ALL") {
    const all = await db.classSubject.findMany({ where: { academicSessionId: s.academicSessionId, classId: s.classId }, select: { id: true }, take: 100 });
    return new Set(all.map((c) => c.id));
  }
  if (scope !== "ASSIGNED" || !hasEmployee(ctx)) return new Set();
  const mine = await db.teacherAllocation.findMany({ where: { sectionId: s.id, employeeId: ctx.employeeId, employee: ALLOCATABLE_TEACHER_EMPLOYEE }, select: { classSubjectId: true }, take: 100 });
  return new Set(mine.map((a) => a.classSubjectId));
}

function readsWholeSection(ctx: AuthContext, s: SectionFacts) {
  const academic = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  return academic === "ALL" || (academic === "ASSIGNED" && s.classTeacherId === ctx.userId && s.academicSession.status !== "CLOSED");
}

/** Sections the caller can open on the homework screen (class-teacher sections ∪ allocated sections ∪ all for ALL readers). */
export async function listHomeworkSections(ctx: AuthContext, academicSessionId: string) {
  const academic = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  const scope = manageScope(ctx);
  if (!academic && !scope) throw new ForbiddenError();
  const all = academic === "ALL" || scope === "ALL";
  const or = [
    ...(academic === "ASSIGNED" ? [{ classTeacherId: ctx.userId }] : []),
    ...(scope === "ASSIGNED" && hasEmployee(ctx) ? [{ teacherAllocations: { some: { employeeId: ctx.employeeId, employee: ALLOCATABLE_TEACHER_EMPLOYEE } } }] : []),
  ];
  if (!all && or.length === 0) return [];
  return prisma.section.findMany({
    where: { academicSessionId, ...(all ? {} : { OR: or, academicSession: { status: { not: "CLOSED" } } }) },
    orderBy: [{ class: { displayOrder: "asc" } }, { code: "asc" }],
    take: 300,
    select: { id: true, code: true },
  });
}

/** A section's homework (newest due first) with the subjects the caller may post for. Out of scope → NotFound. */
export async function getSectionHomework(ctx: AuthContext, sectionId: string) {
  const s = await sectionFacts(prisma, sectionId);
  const manageable = await manageableSubjects(prisma, ctx, s);
  const whole = readsWholeSection(ctx, s);
  if (!whole && manageable.size === 0) throw new NotFoundError("Section not found.");
  const [subjects, items, tz] = await Promise.all([
    prisma.classSubject.findMany({
      where: { academicSessionId: s.academicSessionId, classId: s.classId, ...(whole ? {} : { id: { in: [...manageable] } }) },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, subject: { select: { name: true } } },
    }),
    prisma.homework.findMany({
      where: { sectionId: s.id, deletedAt: null, ...(whole ? {} : { classSubjectId: { in: [...manageable] } }) },
      orderBy: [{ dueOn: "desc" }, { createdAt: "desc" }],
      take: 100,
      select: { id: true, version: true, title: true, details: true, assignedOn: true, dueOn: true, classSubjectId: true, classSubject: { select: { subject: { select: { name: true } } } }, postedBy: { select: { displayName: true } } },
    }),
    getSchoolTimezone(),
  ]);
  return {
    section: { id: s.id, code: s.code, sessionName: s.academicSession.name, sessionEnd: iso(s.academicSession.endDate), closed: s.academicSession.status === "CLOSED" },
    today: todayInTimeZone(tz),
    subjects: subjects.map((c) => ({ id: c.id, name: c.subject.name, canPost: manageable.has(c.id) })),
    items: items.map((h) => ({ ...h, subjectName: h.classSubject.subject.name, postedBy: h.postedBy?.displayName ?? null, canManage: manageable.has(h.classSubjectId) })),
  };
}

async function lockTarget(tx: Tx, ctx: AuthContext, sectionId: string, classSubjectId: string) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  const peek = await sectionFacts(tx, sectionId);
  if (!readsWholeSection(ctx, peek) && !(await manageableSubjects(tx, ctx, peek)).has(classSubjectId)) throw new NotFoundError("Section not found.");
  assertSessionWritable(await lockSessionShared(tx, peek.academicSessionId));
  await tx.$queryRaw`SELECT id FROM section WHERE id = ${sectionId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM teacher_allocation WHERE section_id = ${sectionId} AND class_subject_id = ${classSubjectId} FOR SHARE`;
  const s = await sectionFacts(tx, sectionId);
  const cs = await tx.classSubject.findUnique({ where: { id: classSubjectId }, select: { classId: true, academicSessionId: true } });
  if (!cs || cs.classId !== s.classId || cs.academicSessionId !== s.academicSessionId) throw new NotFoundError("Subject not found for this section.");
  if (!(await manageableSubjects(tx, ctx, s)).has(classSubjectId)) throw new ForbiddenError("You can only post homework for the subjects you teach in this section.");
  return s;
}

async function checkDue(s: SectionFacts, dueOn: string) {
  const today = todayInTimeZone(await getSchoolTimezone());
  const problem = dueOn < today ? "The due date is in the past." : dueOn > iso(s.academicSession.endDate) ? `The due date is after ${s.academicSession.name} ends.` : null;
  if (problem) throw new ValidationError(problem, [{ path: "dueOn", message: problem }]);
  return today;
}

export async function createHomework(ctx: AuthContext, input: CreateHomeworkInput) {
  if (!manageScope(ctx)) throw new ForbiddenError();
  try {
    return await prisma.$transaction(async (tx) => {
      const s = await lockTarget(tx, ctx, input.sectionId, input.classSubjectId);
      const today = await checkDue(s, input.dueOn);
      const assignedOn = today < iso(s.academicSession.startDate) ? iso(s.academicSession.startDate) : today;
      const h = await tx.homework.create({
        data: { academicSessionId: s.academicSessionId, sectionId: s.id, classSubjectId: input.classSubjectId, title: input.title, details: input.details, assignedOn: day(assignedOn), dueOn: day(input.dueOn), postedById: ctx.userId },
        select: { id: true },
      });
      await audit(tx, actorOf(ctx), { action: "homework.create", entityType: "Homework", entityId: h.id, after: { sectionId: s.id, classSubjectId: input.classSubjectId, dueOn: input.dueOn } });
      return h;
    });
  } catch (e) {
    return busy(e);
  }
}

async function lockHomework(tx: Tx, ctx: AuthContext, id: string, version: number) {
  const h = await tx.homework.findUnique({ where: { id }, select: { sectionId: true, classSubjectId: true, deletedAt: true } });
  if (!h || h.deletedAt) throw new NotFoundError("Homework not found.");
  // Review 4C L2: out of scope looks exactly like unknown.
  const s = await lockTarget(tx, ctx, h.sectionId, h.classSubjectId).catch((e: unknown) => {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) throw new NotFoundError("Homework not found.");
    throw e;
  });
  const [row] = await tx.$queryRaw<{ version: number; due_on: Date; deleted_at: Date | null }[]>`SELECT version, due_on, deleted_at FROM homework WHERE id = ${id} FOR UPDATE`;
  if (!row || row.deleted_at) throw new NotFoundError("Homework not found.");
  if (row.version !== version) throw new ConflictError("This homework was changed by someone else. Reload the page and try again.");
  return { s, dueOn: iso(row.due_on) };
}

export async function updateHomework(ctx: AuthContext, input: UpdateHomeworkInput) {
  if (!manageScope(ctx)) throw new ForbiddenError();
  try {
    await prisma.$transaction(async (tx) => {
      const { s, dueOn } = await lockHomework(tx, ctx, input.id, input.version);
      if (input.dueOn !== dueOn) await checkDue(s, input.dueOn);
      await tx.homework.update({ where: { id: input.id }, data: { title: input.title, details: input.details, dueOn: day(input.dueOn), version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "homework.update", entityType: "Homework", entityId: input.id, before: { dueOn }, after: { dueOn: input.dueOn } });
    });
  } catch (e) {
    busy(e);
  }
}

export async function removeHomework(ctx: AuthContext, input: HomeworkRefInput) {
  if (!manageScope(ctx)) throw new ForbiddenError();
  try {
    await prisma.$transaction(async (tx) => {
      await lockHomework(tx, ctx, input.id, input.version);
      await tx.homework.update({ where: { id: input.id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "homework.remove", entityType: "Homework", entityId: input.id });
    });
  } catch (e) {
    busy(e);
  }
}

export const homeworkAccess = (ctx: AuthContext) => {
  const academic = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  return { manage: manageScope(ctx) !== null, any: manageScope(ctx) !== null || academic === "ALL" || academic === "ASSIGNED" };
};
