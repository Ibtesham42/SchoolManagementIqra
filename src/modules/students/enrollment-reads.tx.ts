import type { prisma, Tx } from "@/lib/db";
import { normalizeName } from "./person-fields";

/**
 * Read-only enrollment lookups for other modules (Phase 5 fees, PHASE_5_PLAN.md §2: fees never reads student tables
 * directly). No authorization here — the caller authorized its own operation (e.g. fee.concession.manage) and must
 * only show what its own permission allows. Returns names, permanent IDs and class / section only: no contact, address,
 * Aadhaar, medical or guardian data. Soft-deleted students are never returned.
 */
type Db = Tx | typeof prisma;

const SELECT = {
  studentId: true,
  academicSessionId: true,
  status: true,
  enrolledOn: true,
  leftOn: true,
  student: { select: { studentCode: true, admissionNo: true, fullName: true, admittedSessionId: true } },
  section: { select: { code: true, classId: true, class: { select: { name: true } } } },
} as const;

type Row = { studentId: string; academicSessionId: string; status: string; enrolledOn: Date; leftOn: Date | null; student: { studentCode: string; admissionNo: string; fullName: string; admittedSessionId: string | null }; section: { code: string; classId: string; class: { name: string } } };
const shape = (r: Row) => ({
  studentId: r.studentId,
  academicSessionId: r.academicSessionId,
  status: r.status as "ACTIVE" | "PROMOTED" | "DETAINED" | "LEFT",
  enrolledOn: r.enrolledOn.toISOString().slice(0, 10),
  leftOn: r.leftOn ? r.leftOn.toISOString().slice(0, 10) : null,
  studentCode: r.student.studentCode,
  admissionNo: r.student.admissionNo,
  fullName: r.student.fullName,
  newAdmission: r.student.admittedSessionId === r.academicSessionId,
  classId: r.section.classId,
  className: r.section.class.name,
  sectionCode: r.section.code,
});
export type EnrollmentSummary = ReturnType<typeof shape>;

/** Up to 20 enrollments of a session matching a student ID, admission number or name (prefix / contains). */
export async function searchEnrollments(db: Db, academicSessionId: string, query: string): Promise<EnrollmentSummary[]> {
  const q = query.normalize("NFKC").trim().slice(0, 100);
  if (q.length < 2) return [];
  // Prisma's `contains` doesn't escape LIKE wildcards: "%" / "_" are matched literally.
  const lower = normalizeName(q).replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db.studentEnrollment.findMany({
    where: {
      academicSessionId,
      student: {
        deletedAt: null,
        OR: [{ studentCode: { equals: q.toUpperCase() } }, { admissionNo: { equals: q.toUpperCase() } }, { fullNameNormalized: { contains: lower } }],
      },
    },
    orderBy: [{ student: { fullNameNormalized: "asc" } }, { studentId: "asc" }],
    take: 20,
    select: SELECT,
  });
  return rows.map(shape);
}

/** One enrollment by (student, session), or null. */
export async function enrollmentSummary(db: Db, studentId: string, academicSessionId: string): Promise<EnrollmentSummary | null> {
  const r = await db.studentEnrollment.findFirst({ where: { studentId, academicSessionId, student: { deletedAt: null } }, select: SELECT });
  return r ? shape(r) : null;
}

/**
 * Enrollments of one class in a session for invoice generation (ACTIVE and LEFT; promoted / detained are never
 * billed again — the caller applies the billing rules). At most `limit` rows, ordered by student.
 */
export async function classEnrollments(db: Db, academicSessionId: string, classId: string, limit: number): Promise<EnrollmentSummary[]> {
  const rows = await db.studentEnrollment.findMany({
    where: { academicSessionId, status: { in: ["ACTIVE", "LEFT"] }, section: { classId }, student: { deletedAt: null } },
    orderBy: [{ student: { fullNameNormalized: "asc" } }, { studentId: "asc" }],
    take: limit,
    select: SELECT,
  });
  return rows.map(shape);
}

/**
 * Fee collection (Phase 5B): a student may owe fees from any session, so search across sessions and return each
 * matching student once, with their LATEST enrollment. Same fields and exclusions as searchEnrollments.
 */
export async function searchStudentsAnySession(db: Db, query: string): Promise<EnrollmentSummary[]> {
  const q = query.normalize("NFKC").trim().slice(0, 100);
  if (q.length < 2) return [];
  // Same escaping as searchEnrollments: a backslash before LIKE wildcards (5C fix — the replacement was the literal
  // text "${c}", so a name search containing % or _ never matched).
  const lower = normalizeName(q).replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db.studentEnrollment.findMany({
    where: { student: { deletedAt: null, OR: [{ studentCode: { equals: q.toUpperCase() } }, { admissionNo: { equals: q.toUpperCase() } }, { fullNameNormalized: { contains: lower } }] } },
    orderBy: [{ studentId: "asc" }, { academicSession: { startDate: "desc" } }],
    distinct: ["studentId"],
    take: 20,
    select: SELECT,
  });
  return rows.map(shape).sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
}

/** The latest enrollment of a student (any session), or null. */
export async function latestEnrollment(db: Db, studentId: string): Promise<EnrollmentSummary | null> {
  const r = await db.studentEnrollment.findFirst({ where: { studentId, student: { deletedAt: null } }, orderBy: { academicSession: { startDate: "desc" } }, select: SELECT });
  return r ? shape(r) : null;
}

/**
 * Fee reports (Phase 5C): the enrollments of the given students in one session (ANY status — a report must name a
 * student who left), keyed by student id, with the class level for ordering. Same fields and exclusions as above.
 */
export async function sessionEnrollmentsOf(db: Db, academicSessionId: string, studentIds: readonly string[]): Promise<Map<string, EnrollmentSummary & { classLevel: number }>> {
  const out = new Map<string, EnrollmentSummary & { classLevel: number }>();
  for (let i = 0; i < studentIds.length; i += 1000) {
    const rows = await db.studentEnrollment.findMany({
      where: { academicSessionId, studentId: { in: studentIds.slice(i, i + 1000) }, student: { deletedAt: null } },
      select: { ...SELECT, section: { select: { code: true, classId: true, class: { select: { name: true, numericLevel: true } } } } },
    });
    for (const r of rows) out.set(r.studentId, { ...shape(r), classLevel: r.section.class.numericLevel });
  }
  return out;
}

/** Fee reports (Phase 5C): student ID and name for the given students (any session), keyed by id. Removed students are absent. */
export async function studentLabels(db: Db, studentIds: readonly string[]): Promise<Map<string, { studentCode: string; fullName: string }>> {
  const out = new Map<string, { studentCode: string; fullName: string }>();
  for (let i = 0; i < studentIds.length; i += 1000) {
    const rows = await db.student.findMany({ where: { id: { in: studentIds.slice(i, i + 1000) }, deletedAt: null }, select: { id: true, studentCode: true, fullName: true } });
    for (const r of rows) out.set(r.id, { studentCode: r.studentCode, fullName: r.fullName });
  }
  return out;
}

/**
 * Phase 6B-M1 — the enrollment a portal page is about: the student's ACTIVE enrollment in the latest session, else the
 * latest one of any status (e.g. between a session's close and the promotion). With the session dates and the
 * section, for attendance / timetable / calendar reads. No authorization here: callers ran `assertPortalStudent`.
 */
export async function currentEnrollment(db: Db, studentId: string) {
  const select = {
    id: true,
    status: true,
    enrolledOn: true,
    leftOn: true,
    sectionId: true,
    academicSessionId: true,
    academicSession: { select: { name: true, status: true, startDate: true, endDate: true } },
    section: { select: { code: true, classId: true, class: { select: { name: true } } } },
  } as const;
  const where = { studentId, student: { deletedAt: null } };
  const r =
    (await db.studentEnrollment.findFirst({ where: { ...where, status: "ACTIVE" }, orderBy: { academicSession: { startDate: "desc" } }, select })) ??
    (await db.studentEnrollment.findFirst({ where, orderBy: { academicSession: { startDate: "desc" } }, select }));
  if (!r) return null;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    enrollmentId: r.id,
    status: r.status as "ACTIVE" | "PROMOTED" | "DETAINED" | "LEFT",
    enrolledOn: iso(r.enrolledOn),
    leftOn: r.leftOn ? iso(r.leftOn) : null,
    sectionId: r.sectionId,
    classId: r.section.classId,
    className: r.section.class.name,
    sectionCode: r.section.code,
    academicSessionId: r.academicSessionId,
    sessionName: r.academicSession.name,
    sessionStatus: r.academicSession.status as "PLANNED" | "ACTIVE" | "CLOSED",
    sessionStart: iso(r.academicSession.startDate),
    sessionEnd: iso(r.academicSession.endDate),
  };
}
export type CurrentEnrollment = NonNullable<Awaited<ReturnType<typeof currentEnrollment>>>;
