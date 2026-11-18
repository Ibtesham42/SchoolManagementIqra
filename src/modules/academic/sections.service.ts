import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isUniqueViolationOf, type UniqueIndex } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { canReadSection, CLASS_TEACHER_ROLE_KEYS, sectionScopeWhere } from "./academic.policy";
import {
  assertCapacityFits,
  assertSectionRenameAllowed,
  assertSessionWritable,
  changedFields,
  nameKeyOf,
  planSectionCopy,
  resolveCapacity,
  sectionCodeOf,
  staleError,
  targetKey,
  type SessionStatus,
} from "./academic.rules";
// Shared with admissions (lock order and enrollment counts live in one place).
import { activeEnrollmentCount, lockClassShared, lockSessionShared } from "./academic.tx";
import type { AssignClassTeacherInput, CopySectionsInput, CreateSectionInput, CreateSectionsBulkInput, UpdateSectionInput } from "./academic.schemas";

/**
 * Sections: one class in one academic session. Writes need `academic.manage` and an editable session
 * (PLANNED / ACTIVE — CLOSED is read-only); reads need `academic.read` (ASSIGNED → own class-teacher
 * sections). Design: docs/PHASE_2_CLASSES_SECTIONS_DESIGN.md §2, §6.
 *
 * Lock order in every write (no cycles → no deadlocks):
 *   academic_session FOR SHARE → school_class FOR SHARE (create only) → section FOR UPDATE.
 * FOR SHARE on the session conflicts with the UPDATE a status change makes, so a session can't be
 * closed while a section write in it is in flight (and vice versa). Unique indexes stay the source of
 * truth for duplicates; their violations are mapped to clear messages by index name.
 */
const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const SETTINGS_ID = "default";
const MAX_SECTIONS = 1000;
const MAX_AUDITED_IDS = 200;

export const SECTION_INDEXES = {
  sessionClassName: { index: "section_academic_session_id_class_id_name_key_key", fields: ["academicSessionId", "classId", "nameKey"] },
  sessionCode: { index: "section_academic_session_id_code_key", fields: ["academicSessionId", "code"] },
  sessionClassTeacher: { index: "section_session_class_teacher_key", fields: ["academicSessionId", "classTeacherId"] },
} as const satisfies Record<string, UniqueIndex>;

const SECTION_SELECT = {
  id: true,
  academicSessionId: true,
  classId: true,
  name: true,
  code: true,
  capacity: true,
  classTeacherId: true,
  isActive: true,
  version: true,
  class: { select: { id: true, code: true, name: true, numericLevel: true, displayOrder: true, isActive: true } },
  // Display name only — never username, email or any other account detail.
  classTeacher: { select: { id: true, displayName: true } },
  academicSession: { select: { status: true } },
} satisfies Prisma.SectionSelect;

export type SectionRow = Prisma.SectionGetPayload<{ select: typeof SECTION_SELECT }>;

/** Plain section columns used inside write transactions (and for audit before/after). */
const WRITE_SELECT = {
  id: true,
  academicSessionId: true,
  classId: true,
  name: true,
  code: true,
  capacity: true,
  classTeacherId: true,
  isActive: true,
  version: true,
} satisfies Prisma.SectionSelect;
type WriteRow = Prisma.SectionGetPayload<{ select: typeof WRITE_SELECT }>;

function mapSectionConflict(e: unknown, name?: string): never {
  if (isUniqueViolationOf(e, SECTION_INDEXES.sessionClassName)) throw new ConflictError(`This class already has a section named "${name ?? "that"}" in this session.`);
  if (isUniqueViolationOf(e, SECTION_INDEXES.sessionCode)) {
    throw new ConflictError(`Another section in this session already has the code this name produces${name ? ` ("${name}")` : ""}. Choose a different name.`);
  }
  if (isUniqueViolationOf(e, SECTION_INDEXES.sessionClassTeacher)) throw new ConflictError("This teacher is already class teacher of another section in this session.");
  throw e;
}

// ───────────────────────────── Locks and loads (inside the caller's transaction) ─────────────────────────────

/**
 * Loads a section for a write: session must be editable; the section row is locked; version must match.
 * `allowClosedSession` is ONLY for removing a class teacher (S-02): an access change, not academic data.
 */
async function lockSectionForWrite(tx: Tx, id: string, version: number, opts: { allowClosedSession?: boolean } = {}): Promise<WriteRow> {
  const peek = await tx.section.findUnique({ where: { id }, select: { academicSessionId: true } });
  if (!peek) throw new NotFoundError("Section not found.");
  const sessionStatus = await lockSessionShared(tx, peek.academicSessionId);
  if (!opts.allowClosedSession) assertSessionWritable(sessionStatus);
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM section WHERE id = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError("Section not found.");
  const row = await tx.section.findUniqueOrThrow({ where: { id }, select: WRITE_SELECT });
  if (row.version !== version) throw staleError("section");
  return row;
}

async function schoolDefaultCapacity(tx: Tx): Promise<number | null> {
  return (await tx.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { defaultSectionCapacity: true } }))?.defaultSectionCapacity ?? null;
}

/** Version-checked update; the row is already locked, so a mismatch here means a logic error elsewhere. */
async function bump(tx: Tx, row: WriteRow, data: Prisma.SectionUpdateManyMutationInput & { classTeacherId?: string | null }) {
  const r = await tx.section.updateMany({ where: { id: row.id, version: row.version }, data: { ...data, version: { increment: 1 } } });
  if (r.count !== 1) throw staleError("section");
}

// ───────────────────────────── Reads ─────────────────────────────

export async function listSections(ctx: AuthContext, input: { academicSessionId: string; classId?: string }) {
  const scope = authorize(ctx, "academic.read");
  return prisma.section.findMany({
    where: { academicSessionId: input.academicSessionId, ...(input.classId ? { classId: input.classId } : {}), ...sectionScopeWhere(ctx, scope) },
    orderBy: [{ class: { displayOrder: "asc" } }, { class: { numericLevel: "asc" } }, { class: { name: "asc" } }, { name: "asc" }],
    take: MAX_SECTIONS,
    select: SECTION_SELECT,
  });
}

export async function getSection(ctx: AuthContext, id: string) {
  const scope = authorize(ctx, "academic.read");
  const row = await prisma.section.findUnique({ where: { id }, select: SECTION_SELECT });
  // Out-of-scope rows look exactly like missing ones (no existence oracle).
  if (!row || !canReadSection(ctx, scope, { classTeacherId: row.classTeacherId, sessionStatus: row.academicSession.status })) throw new NotFoundError("Section not found.");
  return row;
}

/** The school-wide default offered in section forms (no other settings are exposed). */
export async function getDefaultSectionCapacity(ctx: AuthContext): Promise<number> {
  authorize(ctx, "academic.manage");
  const row = await prisma.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { defaultSectionCapacity: true } });
  return resolveCapacity(null, null, row?.defaultSectionCapacity);
}

/** Sessions for the sections screen's switcher (names, dates, status and which one is current). */
export async function listSessionsForSections(ctx: AuthContext) {
  authorize(ctx, "academic.read");
  const [sessions, setting] = await prisma.$transaction([
    prisma.academicSession.findMany({ orderBy: { startDate: "desc" }, take: 100, select: { id: true, name: true, status: true } }),
    prisma.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { currentAcademicSessionId: true } }),
  ]);
  return { sessions, currentId: setting?.currentAcademicSessionId ?? null };
}

/** Active, non-deleted users holding the TEACHER or CLASS_TEACHER role — the class-teacher picker. */
export async function listEligibleClassTeachers(ctx: AuthContext) {
  authorize(ctx, "academic.manage");
  return prisma.user.findMany({
    where: eligibleTeacherWhere(),
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
    take: 500,
    select: { id: true, displayName: true },
  });
}

function eligibleTeacherWhere(id?: string): Prisma.UserWhereInput {
  return { ...(id ? { id } : {}), isActive: true, deletedAt: null, roles: { some: { role: { key: { in: [...CLASS_TEACHER_ROLE_KEYS] } } } } };
}

// ───────────────────────────── Create ─────────────────────────────

export async function createSection(ctx: AuthContext, input: CreateSectionInput) {
  const [created] = await createSectionsBulk(ctx, { academicSessionId: input.academicSessionId, classId: input.classId, names: [input.name], capacity: input.capacity });
  return created;
}

/** One or more sections of one class in one session, all-or-nothing ("Add sections A–D"). */
export async function createSectionsBulk(ctx: AuthContext, input: CreateSectionsBulkInput) {
  authorize(ctx, "academic.manage");
  const names = input.names;
  try {
    return await prisma.$transaction(async (tx) => {
      assertSessionWritable(await lockSessionShared(tx, input.academicSessionId));
      const cls = await lockClassShared(tx, input.classId);
      if (!cls.isActive) throw new ConflictError("This class is inactive. Activate it before adding sections.");
      const capacity = resolveCapacity(input.capacity, cls.defaultSectionCapacity, await schoolDefaultCapacity(tx));
      const codes = names.map((n) => sectionCodeOf(cls.code, n));
      if (new Set(codes).size !== codes.length) throw new ValidationError("Two of these names produce the same section code.", [{ path: "names", message: "Names must differ by more than spaces." }]);
      const created: { id: string; name: string; code: string; capacity: number }[] = [];
      for (const [i, name] of names.entries()) {
        try {
          const row = await tx.section.create({
            data: { academicSessionId: input.academicSessionId, classId: cls.id, name, nameKey: nameKeyOf(name), code: codes[i], capacity },
            select: { id: true, name: true, code: true, capacity: true },
          });
          created.push(row);
          await audit(tx, actorOf(ctx), {
            action: "section.create",
            entityType: "Section",
            entityId: row.id,
            after: { academicSessionId: input.academicSessionId, classId: cls.id, name, code: row.code, capacity, classTeacherId: null },
          });
        } catch (e) {
          mapSectionConflict(e, name); // names the offending section; the whole batch rolls back
        }
      }
      return created;
    });
  } catch (e) {
    mapSectionConflict(e);
  }
}

// ───────────────────────────── Update / status / delete ─────────────────────────────

export async function updateSection(ctx: AuthContext, input: UpdateSectionInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const row = await lockSectionForWrite(tx, input.id, input.version);
      const enrolled = await activeEnrollmentCount(tx, row.id);
      assertSectionRenameAllowed(row.name, input.name, enrolled);
      assertCapacityFits(input.capacity, enrolled);
      const next: Partial<WriteRow> = { name: input.name, capacity: input.capacity };
      if (row.name !== input.name) {
        const cls = await tx.schoolClass.findUniqueOrThrow({ where: { id: row.classId }, select: { code: true } });
        next.code = sectionCodeOf(cls.code, input.name);
      }
      const diff = changedFields(row, next);
      if (Object.keys(diff.after).length === 0) return;
      await bump(tx, row, { ...diff.after, ...(diff.after.name ? { nameKey: nameKeyOf(input.name) } : {}) });
      await audit(tx, actorOf(ctx), {
        action: "section.update",
        entityType: "Section",
        entityId: row.id,
        before: { ...diff.before, version: row.version },
        after: { ...diff.after, version: row.version + 1 },
      });
    });
  } catch (e) {
    mapSectionConflict(e, input.name);
  }
}

/** Inactive sections accept no new enrollments; existing ones are unaffected. */
export async function setSectionActive(ctx: AuthContext, id: string, version: number, active: boolean) {
  authorize(ctx, "academic.manage");
  await prisma.$transaction(async (tx) => {
    const row = await lockSectionForWrite(tx, id, version);
    if (row.isActive === active) return;
    if (active) {
      const cls = await tx.schoolClass.findUniqueOrThrow({ where: { id: row.classId }, select: { isActive: true } });
      if (!cls.isActive) throw new ConflictError("This class is inactive. Activate the class first.");
    }
    await bump(tx, row, { isActive: active });
    await audit(tx, actorOf(ctx), { action: "section.status_change", entityType: "Section", entityId: id, before: { isActive: row.isActive }, after: { isActive: active } });
  });
}

/**
 * Hard delete — allowed only in an editable session and while nothing references the section. Today
 * nothing can; once enrollments / roll numbers exist their RESTRICT foreign keys make the database
 * refuse, and this check gives the clear message first.
 */
export async function deleteSection(ctx: AuthContext, id: string, version: number) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const row = await lockSectionForWrite(tx, id, version);
      if ((await activeEnrollmentCount(tx, id)) > 0) throw new ConflictError("Students are enrolled in this section. Deactivate it instead.");
      const r = await tx.section.deleteMany({ where: { id, version } });
      if (r.count !== 1) throw staleError("section");
      await audit(tx, actorOf(ctx), { action: "section.delete", entityType: "Section", entityId: id, before: row });
    });
  } catch (e) {
    if (e && typeof e === "object" && (e as { code?: unknown }).code === "P2003") {
      throw new ConflictError("This section is in use by other records. Deactivate it instead.");
    }
    throw e;
  }
}

// ───────────────────────────── Class teacher ─────────────────────────────

/**
 * Assigning widens the teacher's ASSIGNED scope (academic.read, and student.* for CLASS_TEACHER) to
 * this section. Not an escalation: the permissions come from the teacher's existing role, and the
 * assignment is audited. Eligibility is re-checked inside the transaction.
 */
export async function assignClassTeacher(ctx: AuthContext, input: AssignClassTeacherInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const row = await lockSectionForWrite(tx, input.id, input.version);
      if (row.classTeacherId === input.userId) return;
      // Lock the user row too, so a concurrent deactivation can't slip between the check and the write.
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${input.userId} FOR SHARE`;
      const eligible = await tx.user.count({ where: eligibleTeacherWhere(input.userId) });
      if (eligible !== 1) throw new ValidationError("Choose an active teacher.", [{ path: "userId", message: "Choose an active teacher." }]);
      await bump(tx, row, { classTeacherId: input.userId });
      await audit(tx, actorOf(ctx), {
        action: "section.class_teacher_assign",
        entityType: "Section",
        entityId: row.id,
        before: { classTeacherId: row.classTeacherId },
        after: { classTeacherId: input.userId },
      });
    });
  } catch (e) {
    mapSectionConflict(e);
  }
}

/** Removing a class teacher is allowed in CLOSED sessions too (S-02) — assigning one is not. */
export async function unassignClassTeacher(ctx: AuthContext, id: string, version: number) {
  authorize(ctx, "academic.manage");
  await prisma.$transaction(async (tx) => {
    const row = await lockSectionForWrite(tx, id, version, { allowClosedSession: true });
    if (!row.classTeacherId) return;
    await bump(tx, row, { classTeacherId: null });
    await audit(tx, actorOf(ctx), { action: "section.class_teacher_unassign", entityType: "Section", entityId: id, before: { classTeacherId: row.classTeacherId }, after: { classTeacherId: null } });
  });
}

// ───────────────────────────── Copy from another session ─────────────────────────────

/**
 * Copies ACTIVE sections of ACTIVE classes (name, capacity — no class teachers) into an editable
 * target session; existing (class, name) pairs are skipped. Idempotent; `skipDuplicates` on the
 * unique indexes makes concurrent copies safe as well.
 */
export async function copySectionsFromSession(ctx: AuthContext, input: CopySectionsInput) {
  authorize(ctx, "academic.manage");
  return prisma.$transaction(async (tx) => {
    // Fixed order (by id) so two copies in opposite directions can't deadlock on the session rows.
    const [first, second] = [input.fromSessionId, input.toSessionId].sort();
    const statuses = new Map([
      [first, await lockSessionShared(tx, first)],
      [second, await lockSessionShared(tx, second)],
    ]);
    assertSessionWritable(statuses.get(input.toSessionId)!);

    const source = await tx.section.findMany({
      where: { academicSessionId: input.fromSessionId, isActive: true, class: { isActive: true } },
      take: MAX_SECTIONS,
      select: { classId: true, name: true, nameKey: true, capacity: true, isActive: true, class: { select: { code: true, isActive: true } } },
    });
    const existing = await tx.section.findMany({ where: { academicSessionId: input.toSessionId }, take: MAX_SECTIONS * 2, select: { classId: true, nameKey: true } });
    const plan = planSectionCopy(
      source.map((s) => ({ classId: s.classId, classCode: s.class.code, classActive: s.class.isActive, name: s.name, nameKey: s.nameKey, capacity: s.capacity, isActive: s.isActive })),
      existing.map((s) => targetKey(s.classId, s.nameKey)),
    );
    const createdRows = plan.create.length
      ? await tx.section.createManyAndReturn({
          data: plan.create.map((p) => ({ ...p, academicSessionId: input.toSessionId })),
          skipDuplicates: true,
          select: { id: true },
        })
      : [];
    const result = { created: createdRows.length, skipped: plan.skipped + (plan.create.length - createdRows.length) };
    await audit(tx, actorOf(ctx), {
      action: "section.copy_from_session",
      entityType: "AcademicSession",
      entityId: input.toSessionId,
      before: { fromSessionId: input.fromSessionId },
      after: { ...result, sectionIds: createdRows.slice(0, MAX_AUDITED_IDS).map((r) => r.id) },
    });
    return result;
  });
}
