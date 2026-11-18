import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolationOf } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { formatSequence, nextSequence, sequenceKey, validateFormat } from "@/lib/sequence";
import { Prisma } from "@/generated/prisma/client";
import { activeEnrollmentCount, activeEnrollmentCounts, lockClassShared, lockSectionForUpdate, lockSessionShared, sectionFacts, sessionFacts } from "@/modules/academic/academic.tx";
import { registerStudent } from "@/modules/students/registration";
import { appendRollNumberOnEnrollment } from "@/modules/students/roll-numbers.service";
import { assertAdmissionDate, assertDuplicateOverride, assertSeatAvailable, planPermanentIds, renderId, resolveGuardianLinks } from "@/modules/students/students.rules";
import { readAdmissionSettings } from "@/modules/settings/settings.service";
import { assertApplicationScope } from "./admissions.policy";
import {
  APPLICATION_NO_SEQUENCE,
  assertCanDo,
  assertDeletable,
  assertDobForSession,
  assertSessionOpenForAdmissions,
  assertNotSelfApproval,
  assertVersion,
  changedFieldNames,
  DEFAULT_APPLICATION_NO_FORMAT,
  findDuplicates,
  fullNameOf,
  missingDocuments,
  missingForSubmission,
  normalizeName,
  type AdmissionStatus,
  type DuplicateMatch,
} from "./admissions.rules";
import type {
  ApproveInput,
  ContactStepInput,
  CreateDraftInput,
  GuardiansStepInput,
  ListApplicationsInput,
  PreviousSchoolStepInput,
  UpdateStudentStepInput,
} from "./admissions.schemas";

/**
 * Admission applications (design docs/PHASE_2B_STUDENTS_DESIGN.md §2.2, §5.1). Every function:
 * authorize → scope policy → one transaction (application row FOR UPDATE + optimistic version) → audit
 * in the same transaction. Audit entries record ids, statuses and the NAMES of changed fields — never the
 * applicant's personal values (the application row holds those). Approval (= registration) is S5.
 */
const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const MAX_DUPLICATE_CANDIDATES = 20;

const parseDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const SUMMARY_SELECT = {
  id: true,
  applicationNo: true,
  status: true,
  fullName: true,
  dob: true,
  gender: true,
  updatedAt: true,
  submittedAt: true,
  version: true,
  academicSession: { select: { id: true, name: true } },
  class: { select: { id: true, name: true, code: true } },
  section: { select: { id: true, name: true, code: true } },
} satisfies Prisma.AdmissionApplicationSelect;

const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  academicSessionId: true,
  classId: true,
  sectionId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  phone: true,
  email: true,
  address: true,
  previousSchool: true,
  admissionDate: true,
  duplicateMatches: true,
  duplicateOverride: true,
  rejectionReason: true,
  createdAt: true,
  reviewStartedAt: true,
  decidedAt: true,
  studentId: true,
  student: { select: { id: true, studentCode: true, admissionNo: true } },
  createdBy: { select: { id: true, displayName: true } },
  decidedBy: { select: { id: true, displayName: true } },
  guardians: {
    orderBy: { sortOrder: "asc" },
    select: { id: true, relation: true, name: true, phone: true, altPhone: true, email: true, occupation: true, isPrimary: true, isEmergencyContact: true, sortOrder: true },
  },
  documents: { where: { deletedAt: null }, select: { id: true, type: true } },
} satisfies Prisma.AdmissionApplicationSelect;

export type ApplicationSummary = Prisma.AdmissionApplicationGetPayload<{ select: typeof SUMMARY_SELECT }>;
export type ApplicationDetail = Prisma.AdmissionApplicationGetPayload<{ select: typeof DETAIL_SELECT }>;

const WRITE_SELECT = {
  id: true,
  status: true,
  createdById: true,
  version: true,
  applicationNo: true,
  academicSessionId: true,
  classId: true,
  sectionId: true,
  firstName: true,
  middleName: true,
  lastName: true,
  fullNameNormalized: true,
  dob: true,
  gender: true,
  phone: true,
  email: true,
  address: true,
  previousSchool: true,
} satisfies Prisma.AdmissionApplicationSelect;
type WriteRow = Prisma.AdmissionApplicationGetPayload<{ select: typeof WRITE_SELECT }>;

/** Row lock + version check (inside the caller's transaction). */
async function lockApplication(tx: Tx, id: string, version: number): Promise<WriteRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM admission_application WHERE id = ${id} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError("Application not found.");
  const row = await tx.admissionApplication.findUniqueOrThrow({ where: { id }, select: WRITE_SELECT });
  assertVersion(row.version, version);
  return row;
}

/** Session must accept admissions, class must be active, the child born before the session starts. */
async function checkSessionAndClass(tx: Tx, academicSessionId: string, classId: string, dob: Date) {
  const status = await lockSessionShared(tx, academicSessionId);
  assertSessionOpenForAdmissions(status);
  const session = await sessionFacts(tx, academicSessionId);
  assertDobForSession(dob, session.startDate);
  const cls = await lockClassShared(tx, classId);
  if (!cls.isActive) throw new ValidationError("This class is not open for admissions.", [{ path: "classId", message: "Choose an active class." }]);
  return { session, cls };
}

async function bump(tx: Tx, row: WriteRow, data: Prisma.AdmissionApplicationUncheckedUpdateManyInput) {
  const r = await tx.admissionApplication.updateMany({ where: { id: row.id, version: row.version }, data: { ...data, version: { increment: 1 } } });
  if (r.count !== 1) assertVersion(-1, row.version); // throws the stale-version ConflictError
}

// ───────────────────────────── Reads ─────────────────────────────

export async function listApplications(ctx: AuthContext, input: ListApplicationsInput) {
  assertApplicationScope(authorize(ctx, "admission.read"));
  const q = input.q?.trim();
  const where: Prisma.AdmissionApplicationWhereInput = {
    ...(input.academicSessionId ? { academicSessionId: input.academicSessionId } : {}),
    ...(input.classId ? { classId: input.classId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(q
      ? { OR: [{ fullNameNormalized: { contains: normalizeName(q) } }, { applicationNo: { startsWith: q.toUpperCase() } }] }
      : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.admissionApplication.count({ where }),
    prisma.admissionApplication.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: SUMMARY_SELECT,
    }),
  ]);
  return { total, page: input.page, pageSize: input.pageSize, rows };
}

/** Status counts for the admissions dashboard (one session or all). */
export async function countApplicationsByStatus(ctx: AuthContext, academicSessionId?: string) {
  assertApplicationScope(authorize(ctx, "admission.read"));
  const rows = await prisma.admissionApplication.groupBy({ by: ["status"], where: academicSessionId ? { academicSessionId } : {}, _count: { _all: true } });
  const counts: Record<AdmissionStatus, number> = { DRAFT: 0, SUBMITTED: 0, UNDER_REVIEW: 0, APPROVED: 0, REJECTED: 0 };
  for (const r of rows) counts[r.status] = r._count._all;
  return counts;
}

export async function getApplication(ctx: AuthContext, id: string) {
  assertApplicationScope(authorize(ctx, "admission.read"));
  const app = await prisma.admissionApplication.findUnique({ where: { id }, select: DETAIL_SELECT });
  if (!app) throw new NotFoundError("Application not found.");
  const settings = await readAdmissionSettings(prisma);
  const missingDocs = missingDocuments(settings.requiredAdmissionDocuments, app.documents.map((d) => d.type));
  return { ...app, duplicates: await describeDuplicates(ctx, app.duplicateMatches), missingDocuments: missingDocs };
}

/** Matches stored at submission, resolved to display labels the caller may see (ids/codes/names only). */
async function describeDuplicates(ctx: AuthContext, stored: unknown) {
  const matches = (Array.isArray(stored) ? stored : []) as DuplicateMatch[];
  if (!matches.length) return [];
  const studentIds = matches.filter((m) => m.kind === "student").map((m) => m.id);
  const appIds = matches.filter((m) => m.kind === "application").map((m) => m.id);
  const [students, apps] = await Promise.all([
    studentIds.length && hasPermission(ctx, "student.read")
      ? prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, studentCode: true, fullName: true } })
      : Promise.resolve([]),
    appIds.length ? prisma.admissionApplication.findMany({ where: { id: { in: appIds } }, select: { id: true, applicationNo: true, fullName: true, status: true } }) : Promise.resolve([]),
  ]);
  return matches.map((m) => {
    if (m.kind === "student") {
      const s = students.find((x) => x.id === m.id);
      return { ...m, label: s ? `Student ${s.studentCode} — ${s.fullName}` : "An existing student" };
    }
    const a = apps.find((x) => x.id === m.id);
    return { ...m, label: a ? `Application ${a.applicationNo ?? "(draft)"} — ${a.fullName}` : "Another application" };
  });
}

/** Session and class lists for the application list filters (any admission reader). */
export async function applicationFilterOptions(ctx: AuthContext) {
  assertApplicationScope(authorize(ctx, "admission.read"));
  const [sessions, classes] = await prisma.$transaction([
    prisma.academicSession.findMany({ orderBy: { startDate: "desc" }, take: 50, select: { id: true, name: true } }),
    prisma.schoolClass.findMany({ orderBy: [{ displayOrder: "asc" }, { numericLevel: "asc" }, { name: "asc" }], take: 500, select: { id: true, name: true } }),
  ]);
  return { sessions, classes };
}

/** Sessions open for admissions and active classes — the choices on step 1. */
export async function admissionFormOptions(ctx: AuthContext) {
  authorize(ctx, "admission.create");
  const [sessions, classes, setting] = await prisma.$transaction([
    prisma.academicSession.findMany({ where: { status: { in: ["PLANNED", "ACTIVE"] } }, orderBy: { startDate: "desc" }, take: 20, select: { id: true, name: true, status: true } }),
    prisma.schoolClass.findMany({ where: { isActive: true }, orderBy: [{ displayOrder: "asc" }, { numericLevel: "asc" }, { name: "asc" }], take: 500, select: { id: true, name: true, code: true } }),
    prisma.schoolSetting.findUnique({ where: { id: "default" }, select: { currentAcademicSessionId: true } }),
  ]);
  return { sessions, classes, currentSessionId: setting?.currentAcademicSessionId ?? null };
}

/** Sections an approver may assign: same session and class, with active enrollment counts. */
export async function sectionChoices(ctx: AuthContext, applicationId: string) {
  authorize(ctx, "admission.approve");
  const app = await prisma.admissionApplication.findUnique({ where: { id: applicationId }, select: { academicSessionId: true, classId: true } });
  if (!app) throw new NotFoundError("Application not found.");
  const sections = await prisma.section.findMany({
    where: { academicSessionId: app.academicSessionId, classId: app.classId },
    orderBy: { name: "asc" },
    take: 100,
    select: { id: true, name: true, code: true, capacity: true, isActive: true },
  });
  const counts = await activeEnrollmentCounts(prisma, sections.map((s) => s.id));
  return sections.map((s) => ({ ...s, enrolled: counts.get(s.id) ?? 0 }));
}

// ───────────────────────────── Draft ─────────────────────────────

export async function createDraft(ctx: AuthContext, input: CreateDraftInput) {
  authorize(ctx, "admission.create");
  const dob = parseDate(input.dob);
  const fullName = fullNameOf(input.firstName, input.middleName, input.lastName);
  return prisma.$transaction(async (tx) => {
    await checkSessionAndClass(tx, input.academicSessionId, input.classId, dob);
    const created = await tx.admissionApplication.create({
      data: {
        academicSessionId: input.academicSessionId,
        classId: input.classId,
        firstName: input.firstName,
        middleName: input.middleName,
        lastName: input.lastName,
        fullName,
        fullNameNormalized: normalizeName(fullName),
        dob,
        gender: input.gender,
        createdById: ctx.userId,
      },
      select: { id: true },
    });
    await audit(tx, actorOf(ctx), { action: "admission.create", entityType: "AdmissionApplication", entityId: created.id, after: { status: "DRAFT", academicSessionId: input.academicSessionId, classId: input.classId } });
    return created;
  });
}

export async function updateStudentStep(ctx: AuthContext, input: UpdateStudentStepInput) {
  authorize(ctx, "admission.create");
  const dob = parseDate(input.dob);
  const fullName = fullNameOf(input.firstName, input.middleName, input.lastName);
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, input.id, input.version);
    assertCanDo("edit", row.status);
    await checkSessionAndClass(tx, input.academicSessionId, input.classId, dob);
    const next = { academicSessionId: input.academicSessionId, classId: input.classId, firstName: input.firstName, middleName: input.middleName, lastName: input.lastName, dob, gender: input.gender };
    const fields = changedFieldNames(row, next);
    if (!fields.length) return;
    // A section assigned earlier (application returned to draft) no longer fits another session/class.
    const clearSection = row.sectionId && (row.academicSessionId !== input.academicSessionId || row.classId !== input.classId);
    await bump(tx, row, { ...next, fullName, fullNameNormalized: normalizeName(fullName), ...(clearSection ? { sectionId: null } : {}) });
    await audit(tx, actorOf(ctx), { action: "admission.update", entityType: "AdmissionApplication", entityId: row.id, after: { step: "student", fields, ...(clearSection ? { sectionCleared: true } : {}) } });
  });
}

export async function updateGuardiansStep(ctx: AuthContext, input: GuardiansStepInput) {
  authorize(ctx, "admission.create");
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, input.id, input.version);
    assertCanDo("edit", row.status);
    await tx.admissionGuardian.deleteMany({ where: { applicationId: row.id } });
    await tx.admissionGuardian.createMany({ data: input.guardians.map((g, i) => ({ ...g, applicationId: row.id, sortOrder: i })) });
    await bump(tx, row, {});
    await audit(tx, actorOf(ctx), { action: "admission.update", entityType: "AdmissionApplication", entityId: row.id, after: { step: "guardians", count: input.guardians.length, relations: input.guardians.map((g) => g.relation) } });
  });
}

export async function updateContactStep(ctx: AuthContext, input: ContactStepInput) {
  authorize(ctx, "admission.create");
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, input.id, input.version);
    assertCanDo("edit", row.status);
    const next = { phone: input.phone, email: input.email, address: input.address };
    const fields = changedFieldNames(row, next);
    if (!fields.length) return;
    await bump(tx, row, { phone: input.phone, email: input.email, address: input.address as Prisma.InputJsonValue });
    await audit(tx, actorOf(ctx), { action: "admission.update", entityType: "AdmissionApplication", entityId: row.id, after: { step: "contact", fields } });
  });
}

export async function updatePreviousSchoolStep(ctx: AuthContext, input: PreviousSchoolStepInput) {
  authorize(ctx, "admission.create");
  const value = Object.values(input.previousSchool).some((v) => v !== null) ? input.previousSchool : null;
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, input.id, input.version);
    assertCanDo("edit", row.status);
    const fields = changedFieldNames(row, { previousSchool: value });
    if (!fields.length) return;
    await bump(tx, row, { previousSchool: value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue) });
    await audit(tx, actorOf(ctx), { action: "admission.update", entityType: "AdmissionApplication", entityId: row.id, after: { step: "previousSchool", fields } });
  });
}

/** Hard delete — only a draft that was never submitted (no application number yet). */
export async function deleteDraft(ctx: AuthContext, id: string, version: number) {
  authorize(ctx, "admission.create");
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, id, version);
    assertDeletable(row.status, row.applicationNo);
    if ((await tx.studentDocument.count({ where: { applicationId: id, deletedAt: null } })) > 0) {
      throw new ConflictError("Remove the uploaded documents before deleting this draft.");
    }
    // Rows of documents already removed (their files are retired) go with the never-submitted draft.
    await tx.studentDocument.deleteMany({ where: { applicationId: id, deletedAt: { not: null } } });
    await tx.admissionApplication.delete({ where: { id } }); // guardians CASCADE
    await audit(tx, actorOf(ctx), { action: "admission.delete_draft", entityType: "AdmissionApplication", entityId: id, before: { status: row.status, academicSessionId: row.academicSessionId, classId: row.classId } });
  });
}

// ───────────────────────────── Submit ─────────────────────────────

/** DRAFT → SUBMITTED: completeness, open session/active class, duplicate warnings, application number (D5). */
export async function submitApplication(ctx: AuthContext, id: string, version: number) {
  authorize(ctx, "admission.create");
  return prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, id, version);
    assertCanDo("submit", row.status);
    const guardians = await tx.admissionGuardian.findMany({ where: { applicationId: id }, select: { relation: true, isPrimary: true, phone: true } });
    const missing = missingForSubmission({ guardians, address: row.address });
    if (missing.length) {
      throw new ValidationError(`Complete the application first: ${missing.map((m) => m.message).join(" ")}`, missing.map((m) => ({ path: `step${m.step}`, message: m.message })));
    }
    const { session, cls } = await checkSessionAndClass(tx, row.academicSessionId, row.classId, row.dob);

    const duplicates = findDuplicates(
      { id, fullNameNormalized: row.fullNameNormalized, dob: row.dob, guardianPhones: guardians.map((g) => g.phone) },
      await duplicateCandidates(tx, row.fullNameNormalized, row.dob),
    );

    let applicationNo = row.applicationNo;
    if (!applicationNo) {
      const settings = await readAdmissionSettings(tx);
      const format = settings.formats.applicationNo ?? DEFAULT_APPLICATION_NO_FORMAT;
      if (validateFormat(format)) throw new ConflictError("The application number format in Settings is invalid. Ask a Super Admin to fix it.");
      // D4: {YYYY} is the session's start year.
      const tokens = { code: settings.shortCode, session: session.name, year: session.startDate.getUTCFullYear(), className: cls.code };
      const seq = await nextSequence(tx, sequenceKey(APPLICATION_NO_SEQUENCE, format, tokens));
      applicationNo = formatSequence(format, seq, tokens);
    }
    await bump(tx, row, {
      status: "SUBMITTED",
      applicationNo,
      submittedAt: new Date(),
      duplicateMatches: duplicates.length ? (duplicates as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    });
    await audit(tx, actorOf(ctx), {
      action: "admission.submit",
      entityType: "AdmissionApplication",
      entityId: id,
      before: { status: row.status },
      after: { status: "SUBMITTED", applicationNo, duplicateMatches: duplicates.length },
    });
    return { applicationNo, duplicates: duplicates.length };
  });
}

/** Students (not deleted) and open applications with the same normalised name and date of birth. */
async function duplicateCandidates(tx: Tx, fullNameNormalized: string, dob: Date) {
  const [students, apps] = await Promise.all([
    tx.student.findMany({
      where: { fullNameNormalized, dob, deletedAt: null },
      take: MAX_DUPLICATE_CANDIDATES,
      select: { id: true, fullNameNormalized: true, dob: true, guardians: { select: { guardian: { select: { phone: true } } } } },
    }),
    tx.admissionApplication.findMany({
      where: { fullNameNormalized, dob, status: { in: ["SUBMITTED", "UNDER_REVIEW"] } },
      take: MAX_DUPLICATE_CANDIDATES,
      select: { id: true, fullNameNormalized: true, dob: true, guardians: { select: { phone: true } } },
    }),
  ]);
  return [
    ...students.map((s) => ({ kind: "student" as const, id: s.id, fullNameNormalized: s.fullNameNormalized, dob: s.dob, guardianPhones: s.guardians.map((g) => g.guardian.phone) })),
    ...apps.map((a) => ({ kind: "application" as const, id: a.id, fullNameNormalized: a.fullNameNormalized, dob: a.dob, guardianPhones: a.guardians.map((g) => g.phone) })),
  ];
}

// ───────────────────────────── Review (approvers) ─────────────────────────────

export async function startReview(ctx: AuthContext, id: string, version: number) {
  authorize(ctx, "admission.approve");
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, id, version);
    assertCanDo("startReview", row.status);
    await bump(tx, row, { status: "UNDER_REVIEW", reviewStartedAt: new Date() });
    await audit(tx, actorOf(ctx), { action: "admission.review_start", entityType: "AdmissionApplication", entityId: id, before: { status: row.status }, after: { status: "UNDER_REVIEW" } });
  });
}

/** The section the student will join on approval: same session and class, active. Capacity is enforced at approval. */
export async function setSection(ctx: AuthContext, id: string, version: number, sectionId: string) {
  authorize(ctx, "admission.approve");
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, id, version);
    assertCanDo("setSection", row.status);
    const section = await sectionFacts(tx, sectionId);
    if (section.academicSessionId !== row.academicSessionId || section.classId !== row.classId) {
      throw new ValidationError("Choose a section of the class and session applied for.", [{ path: "sectionId", message: "Section doesn't match the application." }]);
    }
    if (!section.isActive) throw new ValidationError("This section is inactive.", [{ path: "sectionId", message: "Choose an active section." }]);
    if (row.sectionId === sectionId) return;
    await bump(tx, row, { sectionId });
    await audit(tx, actorOf(ctx), { action: "admission.section_set", entityType: "AdmissionApplication", entityId: id, before: { sectionId: row.sectionId }, after: { sectionId } });
  });
}

/** Back to the preparer for corrections; keeps the application number. */
export async function returnToDraft(ctx: AuthContext, id: string, version: number, reason: string) {
  authorize(ctx, "admission.approve");
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, id, version);
    assertCanDo("returnToDraft", row.status);
    await bump(tx, row, { status: "DRAFT" });
    await audit(tx, actorOf(ctx), { action: "admission.return_to_draft", entityType: "AdmissionApplication", entityId: id, before: { status: row.status }, after: { status: "DRAFT", reason } });
  });
}

export async function rejectApplication(ctx: AuthContext, id: string, version: number, reason: string) {
  authorize(ctx, "admission.approve");
  await prisma.$transaction(async (tx) => {
    const row = await lockApplication(tx, id, version);
    assertCanDo("reject", row.status);
    await bump(tx, row, { status: "REJECTED", rejectionReason: reason, decidedAt: new Date(), decidedById: ctx.userId });
    await audit(tx, actorOf(ctx), { action: "admission.reject", entityType: "AdmissionApplication", entityId: id, before: { status: row.status }, after: { status: "REJECTED", reason } });
  });
}

// ───────────────────────────── Approval = registration (S5, owner decision D1) ─────────────────────────────

/** Per-approval lock wait (D11): a blocked approval fails cleanly as "busy" instead of waiting out the 15 s transaction. */
export const APPROVAL_LOCK_TIMEOUT = "5s";

/**
 * Existing guardians with the same phone as an applicant guardian (possible siblings, D9). Shown to the
 * approver, who must choose explicitly; nothing is ever linked automatically. Reveals only the guardian's
 * name and the codes/names of their linked students — to approvers, who may read students anyway.
 */
export async function guardianMatches(ctx: AuthContext, applicationId: string) {
  authorize(ctx, "admission.approve");
  const applicants = await prisma.admissionGuardian.findMany({ where: { applicationId }, orderBy: { sortOrder: "asc" }, select: { id: true, phone: true } });
  if (!applicants.length) return new Map<string, { id: string; name: string; students: string[] }[]>();
  const existing = await prisma.guardian.findMany({
    where: { phone: { in: [...new Set(applicants.map((a) => a.phone))] }, deletedAt: null },
    take: 50,
    select: { id: true, name: true, phone: true, students: { take: 10, select: { student: { select: { studentCode: true, fullName: true } } } } },
  });
  return new Map(
    applicants.map((a) => [
      a.id,
      existing.filter((g) => g.phone === a.phone).map((g) => ({ id: g.id, name: g.name, students: g.students.map((s) => `${s.student.studentCode} — ${s.student.fullName}`) })),
    ]),
  );
}

/**
 * SUBMITTED/UNDER_REVIEW → APPROVED, creating the permanent Student, guardians (new or explicitly linked),
 * the session enrollment and both IDs — ONE short transaction, nothing but database work inside:
 *   lock_timeout 5 s → application FOR UPDATE + version → session FOR SHARE (open) → class FOR SHARE →
 *   section FOR UPDATE (active, same session/class, seat free) → duplicate re-check (override needed) →
 *   linked guardians FOR SHARE (exist, same phone) → ID counters LAST (shortest hold) → registration →
 *   application APPROVED → audit.
 * Guards against double registration: the application row lock, `admission_application.student_id` and
 * `student_enrollment (student, session)` UNIQUE, CHECK APPROVED ⇔ student_id. Capacity is exact because
 * every enrollment into a section holds that section's row lock while counting.
 */
export async function approveApplication(ctx: AuthContext, input: ApproveInput) {
  authorize(ctx, "admission.approve");
  const admissionDate = parseDate(input.admissionDate);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${APPROVAL_LOCK_TIMEOUT}, true) AS lock_timeout`;
      const row = await lockApplication(tx, input.id, input.version);
      assertCanDo("approve", row.status);
      assertNotSelfApproval(row.createdById, ctx.userId); // S-14: four eyes
      if (!row.sectionId) throw new ValidationError("Choose the section first.", [{ path: "sectionId", message: "Choose a section." }]);

      const { session, cls } = await checkSessionAndClass(tx, row.academicSessionId, row.classId, row.dob);
      assertAdmissionDate(admissionDate, session, row.dob);
      const section = await lockSectionForUpdate(tx, row.sectionId);
      if (section.academicSessionId !== row.academicSessionId || section.classId !== row.classId) {
        throw new ValidationError("The chosen section no longer matches the class and session. Choose it again.", [{ path: "sectionId", message: "Section mismatch." }]);
      }
      if (!section.isActive) throw new ConflictError(`Section ${section.code} is inactive. Choose another section.`);
      assertSeatAvailable(await activeEnrollmentCount(tx, section.id), section.capacity, section.code);

      const full = await tx.admissionApplication.findUniqueOrThrow({
        where: { id: row.id },
        select: {
          fullName: true,
          guardians: { orderBy: { sortOrder: "asc" }, select: { id: true, relation: true, name: true, phone: true, altPhone: true, email: true, occupation: true, isPrimary: true, isEmergencyContact: true } },
        },
      });
      if (full.guardians.length === 0) throw new ValidationError("The application has no parent or guardian. Return it to draft for corrections.");

      const duplicates = findDuplicates(
        { id: row.id, fullNameNormalized: row.fullNameNormalized, dob: row.dob, guardianPhones: full.guardians.map((g) => g.phone) },
        await duplicateCandidates(tx, row.fullNameNormalized, row.dob),
      );
      assertDuplicateOverride(duplicates.length, input.duplicateOverride);

      const linkTargets = [...new Set(Object.values(input.guardianLinks).filter((v): v is string => v !== null))];
      if (linkTargets.length) await tx.$queryRaw`SELECT id FROM guardian WHERE id = ANY(${linkTargets}) FOR SHARE`;
      const existing = linkTargets.length ? await tx.guardian.findMany({ where: { id: { in: linkTargets } }, select: { id: true, phone: true, deletedAt: true } }) : [];
      const links = resolveGuardianLinks(full.guardians, input.guardianLinks, existing.map((g) => ({ id: g.id, phone: g.phone, deleted: g.deletedAt !== null })));

      // Permanent IDs LAST: the counter rows stay locked only for the remaining inserts (D11 "keep short").
      const settings = await readAdmissionSettings(tx);
      const ids = planPermanentIds({
        studentIdFormat: settings.formats.studentId,
        admissionNoFormat: settings.formats.admissionNo,
        schoolCode: settings.shortCode,
        sessionName: session.name,
        sessionStart: session.startDate,
        classCode: cls.code,
      });
      const admissionNo = renderId(ids.admissionNo, await nextSequence(tx, ids.admissionNo.key));
      const studentCode = renderId(ids.studentId, await nextSequence(tx, ids.studentId.key));

      const actor = actorOf(ctx);
      const registered = await registerStudent(tx, actor, {
        applicant: { ...row, fullName: full.fullName },
        guardians: full.guardians,
        guardianLinks: links,
        academicSessionId: row.academicSessionId,
        sectionId: section.id,
        admissionDate,
        studentCode,
        admissionNo,
      });
      // D3: a FINALIZED section never re-sorts; the late admission gets the next number (section still locked).
      const rollNumber = await appendRollNumberOnEnrollment(tx, actor, section.id, registered.enrollmentId);
      await bump(tx, row, {
        status: "APPROVED",
        studentId: registered.studentId,
        admissionDate,
        decidedAt: new Date(),
        decidedById: ctx.userId,
        duplicateOverride: duplicates.length ? input.duplicateOverride : null,
      });
      await audit(tx, actor, {
        action: "admission.approve",
        entityType: "AdmissionApplication",
        entityId: row.id,
        before: { status: row.status },
        after: {
          status: "APPROVED",
          studentId: registered.studentId,
          studentCode,
          admissionNo,
          sectionId: section.id,
          duplicateMatches: duplicates.length,
          duplicateOverridden: duplicates.length > 0,
          linkedGuardians: [...links.values()].filter(Boolean).length,
          rollNumber,
        },
      });
      return { studentId: registered.studentId, studentCode, admissionNo, rollNumber };
    });
  } catch (e) {
    if (isTransactionBusy(e)) throw new ServiceBusyError();
    if (isUniqueViolationOf(e, { index: "student_enrollment_student_id_academic_session_id_key", fields: ["studentId", "academicSessionId"] }) || isUniqueViolationOf(e, { index: "admission_application_student_id_key", fields: ["studentId"] })) {
      throw new ConflictError("This application has already been registered.");
    }
    throw e;
  }
}
