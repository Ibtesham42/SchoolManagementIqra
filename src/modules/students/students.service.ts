import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { lockSectionForUpdate, lockSessionShared } from "@/modules/academic/academic.tx";
import { readStoredFile } from "@/modules/files/files.service";
import { readAdmissionSettings } from "@/modules/settings/settings.service";
import { fullNameOf, normalizeName } from "./person-fields";
import { studentScopeOf, studentScopeWhere, type StudentScope } from "./students.policy";
import {
  assertDobBeforeAdmission,
  assertExportSize,
  assertFieldsEditable,
  assertLeavingDate,
  assertStatusChange,
  changedKeys,
  editableGuardianFields,
  editableStudentFields,
  EXPORT_MAX_ROWS,
  exportFilterAudit,
  pick,
  STUDENT_STATUS_LABEL,
  type StudentStatus,
} from "./students.rules";
import type { ChangeStatusInput, ExportStudentsInput, ListStudentsInput, UpdateGuardianInput, UpdateStudentInput } from "./students.schemas";
import { deactivateStudentAccountOnLeavingTx } from "./family-accounts.service";

/**
 * Student records after registration (design §5.1, slice S7): directory, profile, field-level edits,
 * status changes (leaving), CSV export and scoped photo/document reads.
 *
 * Every function: authorize → record scope (students.policy) → explicit `select` → (writes) one short
 * transaction with row locks, lock_timeout 5 s (D11) and audit in the same transaction. Permanent IDs are
 * never written here. Lock order for writes: student FOR UPDATE → academic_session FOR SHARE → section
 * FOR UPDATE (approval and roll-number writes never lock a student row, so no cycle is possible).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const DOCUMENT_OWNER_TYPE = "StudentDocument";
const parseDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Read scope for student records; SELF/CHILDREN (no portal link yet) are refused. */
function readScope(ctx: AuthContext): StudentScope {
  return studentScopeOf(authorize(ctx, "student.read"));
}

/** Can this user use the student directory at all? (Pages use it to show NotPermitted instead of an error.) */
export function canBrowseStudents(ctx: AuthContext): boolean {
  const scope = hasPermission(ctx, "student.read") ? scopeFor(ctx, "student.read") : null;
  return scope === "ALL" || scope === "ASSIGNED";
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

/** Row lock on a live student, then the scope check on the locked row (NotFound for both — no oracle). */
async function lockStudent(tx: Tx, id: string, scope: StudentScope, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM student WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Student not found.");
  const row = await tx.student.findFirst({
    where: { id, ...studentScopeWhere(scope, userId) },
    select: { id: true, version: true, status: true, firstName: true, middleName: true, lastName: true, dob: true, gender: true, phone: true, email: true, address: true, admissionDate: true },
  });
  if (!row) throw new NotFoundError("Student not found.");
  return row;
}

function stale(): never {
  throw new ConflictError("This student record was changed by someone else. Reload the page and try again.");
}

function mapBusy(e: unknown): never {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}

// ───────────────────────────── Directory ─────────────────────────────

function directoryWhere(scope: StudentScope, userId: string, input: ExportStudentsInput): Prisma.StudentWhereInput {
  const q = input.q?.trim();
  const enrollment: Prisma.StudentEnrollmentWhereInput = {
    ...(input.academicSessionId ? { academicSessionId: input.academicSessionId } : {}),
    ...(input.sectionId ? { sectionId: input.sectionId } : {}),
    ...(input.classId ? { section: { classId: input.classId } } : {}),
  };
  const and: Prisma.StudentWhereInput[] = [studentScopeWhere(scope, userId)];
  if (Object.keys(enrollment).length) and.push({ enrollments: { some: enrollment } });
  if (input.status) and.push({ status: input.status });
  if (q) {
    and.push({ OR: [{ fullNameNormalized: { contains: normalizeName(q) } }, { studentCode: { startsWith: q.toUpperCase() } }, { admissionNo: { startsWith: q.toUpperCase() } }] });
  }
  return { AND: and };
}

/** The enrollment shown next to a student: the filtered session's, else the most recent one. */
const enrollmentSelect = (academicSessionId?: string) =>
  ({
    where: academicSessionId ? { academicSessionId } : {},
    orderBy: { academicSession: { startDate: "desc" } },
    take: 1,
    select: {
      status: true,
      academicSession: { select: { id: true, name: true } },
      section: { select: { id: true, name: true, code: true, class: { select: { name: true } } } },
      rollNumber: { select: { rollNumber: true } },
    },
  }) satisfies Prisma.Student$enrollmentsArgs;

export async function listStudents(ctx: AuthContext, input: ListStudentsInput) {
  const scope = readScope(ctx);
  const where = directoryWhere(scope, ctx.userId, input);
  const [total, rows] = await prisma.$transaction([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      orderBy: [{ fullNameNormalized: "asc" }, { id: "asc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: { id: true, studentCode: true, admissionNo: true, fullName: true, gender: true, status: true, enrollments: enrollmentSelect(input.academicSessionId) },
    }),
  ]);
  return { total, page: input.page, pageSize: input.pageSize, rows: rows.map(({ enrollments, ...s }) => ({ ...s, enrollment: enrollments[0] ?? null })) };
}

/** Student counts by status within the caller's scope (directory header). */
export async function countStudentsByStatus(ctx: AuthContext, academicSessionId?: string) {
  const scope = readScope(ctx);
  const where = directoryWhere(scope, ctx.userId, { academicSessionId });
  const rows = await prisma.student.groupBy({ by: ["status"], where, _count: { _all: true } });
  const counts: Record<StudentStatus, number> = { ACTIVE: 0, TRANSFERRED: 0, GRADUATED: 0, WITHDRAWN: 0 };
  for (const r of rows) counts[r.status] = r._count._all;
  return counts;
}

/** Sessions, classes and (for one session) sections for the directory filters. */
export async function studentFilterOptions(ctx: AuthContext, academicSessionId?: string) {
  readScope(ctx);
  const [sessions, classes, sections, setting] = await prisma.$transaction([
    prisma.academicSession.findMany({ orderBy: { startDate: "desc" }, take: 50, select: { id: true, name: true } }),
    prisma.schoolClass.findMany({ orderBy: [{ displayOrder: "asc" }, { numericLevel: "asc" }, { name: "asc" }], take: 500, select: { id: true, name: true } }),
    prisma.section.findMany({
      where: academicSessionId ? { academicSessionId } : { id: "__none__" },
      orderBy: [{ class: { displayOrder: "asc" } }, { class: { numericLevel: "asc" } }, { name: "asc" }],
      take: 500,
      select: { id: true, name: true, classId: true, class: { select: { name: true } } },
    }),
    prisma.schoolSetting.findUnique({ where: { id: "default" }, select: { currentAcademicSessionId: true } }),
  ]);
  return { sessions, classes, sections, currentSessionId: setting?.currentAcademicSessionId ?? null };
}

// ───────────────────────────── Profile ─────────────────────────────

export async function getStudent(ctx: AuthContext, id: string) {
  const scope = readScope(ctx);
  const student = await prisma.student.findFirst({
    where: { id, ...studentScopeWhere(scope, ctx.userId) },
    select: {
      id: true,
      studentCode: true,
      admissionNo: true,
      firstName: true,
      middleName: true,
      lastName: true,
      fullName: true,
      dob: true,
      gender: true,
      phone: true,
      email: true,
      address: true,
      previousSchool: true,
      status: true,
      admissionDate: true,
      version: true,
      admittedSession: { select: { name: true } },
      guardians: {
        where: { guardian: { deletedAt: null } },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        take: 10,
        select: {
          relation: true,
          isPrimary: true,
          isEmergencyContact: true,
          guardian: { select: { id: true, name: true, phone: true, altPhone: true, email: true, occupation: true, _count: { select: { students: true } } } },
        },
      },
      enrollments: {
        orderBy: { academicSession: { startDate: "desc" } },
        take: 30,
        select: {
          id: true,
          status: true,
          enrolledOn: true,
          leftOn: true,
          academicSession: { select: { id: true, name: true, status: true } },
          section: { select: { id: true, name: true, code: true, class: { select: { name: true } } } },
          rollNumber: { select: { rollNumber: true, source: true } },
        },
      },
      statusChanges: {
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, fromStatus: true, toStatus: true, reason: true, effectiveDate: true, createdAt: true, actedBy: { select: { displayName: true } } },
      },
      documents: { where: { deletedAt: null, type: "PHOTO" }, take: 1, select: { id: true } },
    },
  });
  if (!student) throw new NotFoundError("Student not found.");

  const [documents, application] = await Promise.all([
    hasPermission(ctx, "student.document.read")
      ? prisma.studentDocument.findMany({
          where: { studentId: id, deletedAt: null },
          orderBy: [{ type: "asc" }, { createdAt: "asc" }],
          take: 50,
          select: { id: true, type: true, label: true, createdAt: true, verifiedAt: true, file: { select: { mimeType: true, sizeBytes: true } }, verifiedBy: { select: { displayName: true } } },
        })
      : Promise.resolve(null),
    // Applications are ALL-scope records (admissions policy): only an ALL-scope reader sees the link.
    scopeFor(ctx, "admission.read") === "ALL"
      ? prisma.admissionApplication.findUnique({ where: { studentId: id }, select: { id: true, applicationNo: true, decidedAt: true } })
      : Promise.resolve(null),
  ]);
  const { documents: photo, ...rest } = student;
  return { ...rest, hasPhoto: photo.length > 0, documents, application };
}

// ───────────────────────────── Edits (field-level) ─────────────────────────────

function updateScopeOf(ctx: AuthContext): StudentScope {
  return studentScopeOf(authorize(ctx, "student.update"));
}

export async function updateStudent(ctx: AuthContext, input: UpdateStudentInput) {
  const scope = updateScopeOf(ctx);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const row = await lockStudent(tx, input.id, scope, ctx.userId);
      if (row.version !== input.version) stale();
      const next = {
        firstName: input.firstName,
        middleName: input.middleName,
        lastName: input.lastName,
        dob: input.dob === undefined ? undefined : parseDate(input.dob),
        gender: input.gender,
        phone: input.phone,
        email: input.email,
        address: input.address,
      };
      const changed = changedKeys(row, next);
      if (!changed.length) return { changed: [] as string[] };
      assertFieldsEditable(changed, editableStudentFields(scope));

      const merged = { ...row, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) } as typeof row;
      if (changed.includes("dob")) assertDobBeforeAdmission(merged.dob, row.admissionDate);
      const nameChanged = changed.some((f) => f === "firstName" || f === "middleName" || f === "lastName");
      const fullName = fullNameOf(merged.firstName, merged.middleName, merged.lastName);

      const data: Prisma.StudentUpdateManyMutationInput = {
        ...pick(next, changed.filter((f) => f !== "address")),
        ...(changed.includes("address") ? { address: input.address as Prisma.InputJsonValue } : {}),
        ...(nameChanged ? { fullName, fullNameNormalized: normalizeName(fullName) } : {}),
        version: { increment: 1 },
      };
      const r = await tx.student.updateMany({ where: { id: row.id, version: row.version }, data });
      if (r.count !== 1) stale();
      const dated = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v instanceof Date ? isoDate(v) : v]));
      await audit(tx, actorOf(ctx), {
        action: "student.update",
        entityType: "Student",
        entityId: row.id,
        before: { fields: changed, ...dated(pick(row, changed)) },
        after: { fields: changed, ...dated(pick(merged, changed)) },
      });
      return { changed };
    });
  } catch (e) {
    mapBusy(e);
  }
}

/**
 * Guardian contact details, edited from one of their children's records. A guardian shared by siblings
 * changes for all of them (one person, one phone number) — the screen says so before saving.
 */
export async function updateGuardian(ctx: AuthContext, input: UpdateGuardianInput) {
  const scope = updateScopeOf(ctx);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      await lockStudent(tx, input.studentId, scope, ctx.userId);
      const link = await tx.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId: input.studentId, guardianId: input.guardianId } }, select: { guardianId: true } });
      if (!link) throw new NotFoundError("Guardian not found.");
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM guardian WHERE id = ${input.guardianId} AND deleted_at IS NULL FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError("Guardian not found.");
      const row = await tx.guardian.findUniqueOrThrow({ where: { id: input.guardianId }, select: { id: true, name: true, occupation: true, phone: true, altPhone: true, email: true } });
      const next = { name: input.name, occupation: input.occupation, phone: input.phone, altPhone: input.altPhone, email: input.email };
      const changed = changedKeys(row, next);
      if (!changed.length) return { changed: [] as string[] };
      assertFieldsEditable(changed, editableGuardianFields(scope));
      // S-13 (owner decision): a class teacher may not change a guardian who is also linked to a student
      // outside their own scope (e.g. a sibling in another section) — only an ALL-scope editor may.
      if (scope === "ASSIGNED") {
        const outside = await tx.studentGuardian.count({ where: { guardianId: row.id, student: { NOT: studentScopeWhere(scope, ctx.userId) } } });
        if (outside > 0) throw new ForbiddenError("This parent/guardian is also linked to a student outside your section. Ask a School Admin to change these details.");
      }
      await tx.guardian.update({ where: { id: row.id }, data: pick(next, changed) as Prisma.GuardianUpdateInput });
      await audit(tx, actorOf(ctx), {
        action: "guardian.update",
        entityType: "Guardian",
        entityId: row.id,
        before: { studentId: input.studentId, fields: changed, ...pick(row, changed) },
        after: { studentId: input.studentId, fields: changed, ...pick(next, changed) },
      });
      return { changed };
    });
  } catch (e) {
    mapBusy(e);
  }
}

// ───────────────────────────── Status changes ─────────────────────────────

/** The school's time zone, for "today" on the leaving-date form (the service re-checks inside the transaction). */
export async function studentTimeZone(ctx: AuthContext): Promise<string | undefined> {
  authorize(ctx, "student.transfer");
  return (await readAdmissionSettings(prisma)).timezone ?? undefined;
}

/**
 * Transfer / withdrawal / graduation (`student.transfer`). One transaction: student FOR UPDATE + version →
 * transition rule → each ACTIVE enrollment in a session that is not CLOSED: session FOR SHARE, section
 * FOR UPDATE (serializes with roll-number generation and approvals into that section) → enrollment LEFT
 * with the leaving date → student status → append-only StudentStatusChange → audit. Roll numbers are kept
 * (a finalized number is never reused); a DRAFT roll list becomes stale and must be generated again.
 */
export async function changeStudentStatus(ctx: AuthContext, input: ChangeStatusInput) {
  const scope = studentScopeOf(authorize(ctx, "student.transfer"));
  const effective = parseDate(input.effectiveDate);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const row = await lockStudent(tx, input.id, scope, ctx.userId);
      if (row.version !== input.version) stale();
      assertStatusChange(row.status, input.toStatus);

      const enrollments = await tx.studentEnrollment.findMany({
        where: { studentId: row.id, status: "ACTIVE" },
        take: 10,
        select: { id: true, academicSessionId: true, sectionId: true, enrolledOn: true },
      });
      const closing: typeof enrollments = [];
      for (const en of enrollments) {
        if ((await lockSessionShared(tx, en.academicSessionId)) === "CLOSED") continue; // closed sessions stay as history
        await lockSectionForUpdate(tx, en.sectionId);
        closing.push(en);
      }
      const earliest = closing.reduce((d, en) => (en.enrolledOn > d ? en.enrolledOn : d), row.admissionDate);
      const { timezone } = await readAdmissionSettings(tx);
      assertLeavingDate(effective, earliest, todayInTimeZone(timezone ?? undefined));

      if (closing.length) {
        await tx.studentEnrollment.updateMany({ where: { id: { in: closing.map((e) => e.id) }, status: "ACTIVE" }, data: { status: "LEFT", leftOn: effective } });
      }
      const r = await tx.student.updateMany({ where: { id: row.id, version: row.version }, data: { status: input.toStatus, version: { increment: 1 } } });
      if (r.count !== 1) stale();
      // Phase 6C-M4 (P17): the student's OWN portal account ends with the leaving, in this transaction (student lock held).
      await deactivateStudentAccountOnLeavingTx(tx, actorOf(ctx), row.id); // every target status is a leaving one
      const change = await tx.studentStatusChange.create({
        data: { studentId: row.id, fromStatus: row.status, toStatus: input.toStatus, reason: input.reason, effectiveDate: effective, actedById: ctx.userId },
        select: { id: true },
      });
      // The reason stays in the status-change row (shown on the profile); the audit carries ids and dates only.
      await audit(tx, actorOf(ctx), {
        action: "student.status_change",
        entityType: "Student",
        entityId: row.id,
        before: { status: row.status },
        after: { status: input.toStatus, effectiveDate: input.effectiveDate, statusChangeId: change.id, enrollmentsLeft: closing.map((e) => e.id) },
      });
      return { status: input.toStatus, label: STUDENT_STATUS_LABEL[input.toStatus], enrollmentsLeft: closing.length };
    });
  } catch (e) {
    mapBusy(e);
  }
}

// ───────────────────────────── Export ─────────────────────────────

export const EXPORT_HEADER = [
  "Student ID",
  "Admission no.",
  "Full name",
  "Gender",
  "Date of birth",
  "Session",
  "Class",
  "Section",
  "Roll no.",
  "Status",
  "Admission date",
  "Student phone",
  "Student email",
  "Primary guardian",
  "Relation",
  "Guardian phone",
] as const;

/**
 * CSV of the directory (design §5.1): `export.run` + `student.read` (scope applied) + `admission.read` at
 * ALL scope — so an Accountant, who holds export.run for finance, can't export student data (D8). At most
 * EXPORT_MAX_ROWS rows (refused above, never truncated). No sensitive fields exist in Phase 2B (D6).
 * Audited with the filters and the row count — never the data. The route rate-limits the caller.
 */
export async function exportStudentRows(ctx: AuthContext, input: ExportStudentsInput) {
  authorize(ctx, "export.run");
  if (authorize(ctx, "admission.read") !== "ALL") throw new ForbiddenError();
  const scope = readScope(ctx);
  const where = directoryWhere(scope, ctx.userId, input);
  // One query, one snapshot: fetch one row more than the limit and refuse if it is there (never truncate).
  const rows = await prisma.student.findMany({
    where,
    orderBy: [{ fullNameNormalized: "asc" }, { id: "asc" }],
    take: EXPORT_MAX_ROWS + 1,
    select: {
      studentCode: true,
      admissionNo: true,
      fullName: true,
      gender: true,
      dob: true,
      status: true,
      admissionDate: true,
      phone: true,
      email: true,
      enrollments: enrollmentSelect(input.academicSessionId),
      guardians: { where: { isPrimary: true, guardian: { deletedAt: null } }, take: 1, select: { relation: true, guardian: { select: { name: true, phone: true } } } },
    },
  });
  assertExportSize(rows.length);
  const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
  const csv = toCsv(
    EXPORT_HEADER,
    rows.map((s) => {
      const en = s.enrollments[0];
      const g = s.guardians[0];
      return [
        s.studentCode,
        s.admissionNo,
        s.fullName,
        cap(s.gender),
        isoDate(s.dob),
        en?.academicSession.name,
        en?.section.class.name,
        en?.section.name,
        en?.rollNumber?.rollNumber,
        STUDENT_STATUS_LABEL[s.status],
        isoDate(s.admissionDate),
        s.phone,
        s.email,
        g?.guardian.name,
        g ? cap(g.relation) : null,
        g?.guardian.phone,
      ];
    }),
  );
  await prisma.$transaction((tx) =>
    audit(tx, actorOf(ctx), { action: "student.export", entityType: "Student", entityId: "export", after: { filters: exportFilterAudit(input), rows: rows.length, format: "csv" } }),
  );
  return { csv, rows: rows.length };
}

// ───────────────────────────── Photo and documents ─────────────────────────────

/** The current photo, for anyone who may read the student (design §4.2). The file layer audits the read. */
export async function readStudentPhoto(ctx: AuthContext, studentId: string) {
  const scope = readScope(ctx);
  const doc = await prisma.studentDocument.findFirst({
    where: { studentId, type: "PHOTO", deletedAt: null, student: studentScopeWhere(scope, ctx.userId) },
    select: { id: true, fileId: true },
  });
  if (!doc) throw new NotFoundError("Photo not found.");
  return readStoredFile(ctx, doc.fileId, { purpose: "student.photo", owner: { type: DOCUMENT_OWNER_TYPE, id: doc.id } });
}

/** A student's document: student scope first, then the file layer requires `student.document.read`. */
export async function readStudentDocument(ctx: AuthContext, studentId: string, documentId: string) {
  const scope = readScope(ctx);
  authorize(ctx, "student.document.read");
  const doc = await prisma.studentDocument.findFirst({
    where: { id: documentId, studentId, deletedAt: null, student: studentScopeWhere(scope, ctx.userId) },
    select: { id: true, type: true, fileId: true },
  });
  if (!doc) throw new NotFoundError("Document not found.");
  const purpose = doc.type === "PHOTO" ? ("student.photo" as const) : ("student.document" as const);
  return readStoredFile(ctx, doc.fileId, { purpose, owner: { type: DOCUMENT_OWNER_TYPE, id: doc.id } });
}
