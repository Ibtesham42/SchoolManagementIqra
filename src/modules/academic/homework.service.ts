import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { stripDocumentImageMetadata } from "@/lib/images/photo";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { detectFileType } from "@/lib/storage/file-types";
import { discardUpload, prepareUpload, readStoredFile, recordUpload, retireStoredFile, type PreparedUpload } from "@/modules/files/files.service";
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
 * Attachment (KI-094): at most one private, encrypted file per homework (StoredFile purpose `homework.attachment`, owner
 * ("Homework", id)); replacing retires the old one. Upload / remove = the same rights and locks as editing; download =
 * the same rights as reading the homework, then the file layer's purpose / owner / `academic.read` check. Unknown and
 * out-of-scope look the same (NotFound).
 */
const ATTACHMENT = "homework.attachment" as const;
const OWNER_TYPE = "Homework";
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
  const files = items.length
    ? await prisma.storedFile.findMany({
        where: { purpose: ATTACHMENT, ownerType: OWNER_TYPE, ownerId: { in: items.map((h) => h.id) }, deletedAt: null },
        select: { ownerId: true, originalName: true, sizeBytes: true, mimeType: true },
      })
    : [];
  // Review L1: the file layer reads attachments with academic.read — no link for a caller who couldn't download it.
  const canDownload = hasPermission(ctx, "academic.read");
  const fileOf = new Map(files.filter(() => canDownload).map((f) => [f.ownerId, { name: f.originalName, sizeBytes: f.sizeBytes, mimeType: f.mimeType }]));
  return {
    section: { id: s.id, code: s.code, sessionName: s.academicSession.name, sessionEnd: iso(s.academicSession.endDate), closed: s.academicSession.status === "CLOSED" },
    today: todayInTimeZone(tz),
    subjects: subjects.map((c) => ({ id: c.id, name: c.subject.name, canPost: manageable.has(c.id) })),
    items: items.map((h) => ({ ...h, subjectName: h.classSubject.subject.name, postedBy: h.postedBy?.displayName ?? null, canManage: manageable.has(h.classSubjectId), attachment: fileOf.get(h.id) ?? null })),
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
      await retireAttachments(tx, ctx, input.id);
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

// ───────────────────────────── Attachment (KI-094) ─────────────────────────────

async function retireAttachments(tx: Tx, ctx: AuthContext, homeworkId: string): Promise<number> {
  const old = await tx.storedFile.findMany({ where: { purpose: ATTACHMENT, ownerType: OWNER_TYPE, ownerId: homeworkId, deletedAt: null }, select: { id: true }, take: 10 });
  for (const f of old) await retireStoredFile(tx, ctx, f.id);
  return old.length;
}

/** Adds or replaces the homework's attachment. Scope is checked BEFORE the file is stored; images lose their metadata. */
export async function attachHomeworkFile(ctx: AuthContext, input: HomeworkRefInput, file: { bytes: Uint8Array; fileName: string }) {
  if (!manageScope(ctx)) throw new ForbiddenError();
  // Cheap scope check first (no blob written for out-of-scope callers); repeated under the locks below.
  const h = await prisma.homework.findUnique({ where: { id: input.id }, select: { sectionId: true, classSubjectId: true, deletedAt: true } });
  if (!h || h.deletedAt || !(await manageableSubjects(prisma, ctx, await sectionFacts(prisma, h.sectionId))).has(h.classSubjectId)) throw new NotFoundError("Homework not found.");
  let bytes = file.bytes;
  const detected = detectFileType(bytes);
  if (detected === "image/jpeg" || detected === "image/png") bytes = await stripDocumentImageMetadata(bytes, detected);
  const prepared: PreparedUpload = await prepareUpload(ctx, ATTACHMENT, bytes, file.fileName, { type: OWNER_TYPE, id: input.id });
  try {
    await prisma.$transaction(async (tx) => {
      await lockHomework(tx, ctx, input.id, input.version);
      const replaced = await retireAttachments(tx, ctx, input.id);
      const stored = await recordUpload(tx, ctx, prepared);
      await tx.homework.update({ where: { id: input.id }, data: { version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: replaced ? "homework.attachment_replace" : "homework.attachment_add", entityType: "Homework", entityId: input.id, after: { fileId: stored.id, mimeType: prepared.mimeType, sizeBytes: prepared.sizeBytes } });
    });
  } catch (e) {
    await discardUpload(prepared); // storage and database stay consistent
    busy(e);
  }
}

export async function removeHomeworkAttachment(ctx: AuthContext, input: HomeworkRefInput) {
  if (!manageScope(ctx)) throw new ForbiddenError();
  try {
    await prisma.$transaction(async (tx) => {
      await lockHomework(tx, ctx, input.id, input.version);
      if ((await retireAttachments(tx, ctx, input.id)) === 0) throw new NotFoundError("This homework has no attachment.");
      await tx.homework.update({ where: { id: input.id }, data: { version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "homework.attachment_remove", entityType: "Homework", entityId: input.id });
    });
  } catch (e) {
    busy(e);
  }
}

/** Download: whoever may read this homework (whole section, or the subject they manage). Anything else → NotFound. */
export async function readHomeworkAttachment(ctx: AuthContext, homeworkId: string) {
  // Review L1: the file rule's readPermission (academic.read) is required up front, before any database access.
  if (!hasPermission(ctx, "academic.read")) throw new NotFoundError("Attachment not found.");
  const h = await prisma.homework.findUnique({ where: { id: homeworkId }, select: { sectionId: true, classSubjectId: true, deletedAt: true } });
  if (!h || h.deletedAt) throw new NotFoundError("Attachment not found.");
  const s = await sectionFacts(prisma, h.sectionId);
  if (!readsWholeSection(ctx, s) && !(await manageableSubjects(prisma, ctx, s)).has(h.classSubjectId)) throw new NotFoundError("Attachment not found.");
  const f = await prisma.storedFile.findFirst({ where: { purpose: ATTACHMENT, ownerType: OWNER_TYPE, ownerId: homeworkId, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!f) throw new NotFoundError("Attachment not found.");
  return readStoredFile(ctx, f.id, { purpose: ATTACHMENT, owner: { type: OWNER_TYPE, id: homeworkId } });
}
