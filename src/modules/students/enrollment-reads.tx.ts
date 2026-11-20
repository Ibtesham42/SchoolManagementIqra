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
