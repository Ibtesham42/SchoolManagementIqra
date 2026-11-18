import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolationOf } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { authorize, authorizeAny, type AuthContext } from "@/lib/rbac/authorize";
import { activeEnrollmentCounts, lockSectionForUpdate, lockSessionShared, sectionFacts } from "@/modules/academic/academic.tx";
import { assertSessionWritable } from "@/modules/academic/academic.rules";
import { assertCorrection, assertFinalizeConfirmation, draftMatchesCurrent, nextAppendedNumber, orderForRollNumbers, type RollCandidate } from "./roll-number";

/**
 * Roll numbers per section (owner decision D3; skill roll-number-generation): preview → generate (DRAFT,
 * replaceable) → finalize (type-to-confirm; draft must still match) → later admissions APPENDED inside the
 * approval transaction → explicit corrections with a reason. Finalized numbers never change automatically.
 *
 * Lock order (same as approval; no cycles): academic_session FOR SHARE → section FOR UPDATE →
 * roll_number_batch FOR UPDATE. Every write sets lock_timeout 5 s (D11) and audits in the same transaction.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const ROLL_PERMISSIONS = ["rollnumber.generate", "rollnumber.finalize", "rollnumber.correct"] as const;
const MAX_STUDENTS = 1000;

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

async function lockBatch(tx: Tx, sectionId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM roll_number_batch WHERE section_id = ${sectionId} FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.rollNumberBatch.findUniqueOrThrow({ where: { id: rows[0].id }, select: { id: true, status: true, version: true } });
}

/** ACTIVE enrollments of a section with what ordering needs. */
async function candidates(tx: Tx, sectionId: string): Promise<(RollCandidate & { studentId: string })[]> {
  const rows = await tx.studentEnrollment.findMany({
    where: { sectionId, status: "ACTIVE", student: { deletedAt: null } },
    take: MAX_STUDENTS,
    select: { id: true, student: { select: { id: true, fullName: true, dob: true, studentCode: true } } },
  });
  return rows.map((r) => ({ enrollmentId: r.id, studentId: r.student.id, fullName: r.student.fullName, dob: r.student.dob, studentCode: r.student.studentCode }));
}

/** Session must not be CLOSED; then the section row is locked (serializes with approvals enrolling into it). */
async function lockForRollWrite(tx: Tx, sectionId: string) {
  const facts = await sectionFacts(tx, sectionId);
  assertSessionWritable(await lockSessionShared(tx, facts.academicSessionId));
  return lockSectionForUpdate(tx, sectionId);
}

function mapBusy(e: unknown): never {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  if (isUniqueViolationOf(e, { index: "student_roll_number_batch_id_roll_number_key", fields: ["batchId", "rollNumber"] })) {
    throw new ConflictError("That roll number was just taken. Reload the page and try again.");
  }
  throw e;
}

// ───────────────────────────── Reads ─────────────────────────────

/** Sections of a session with enrolled counts and roll-number status (the registration overview). */
export async function listSectionsForRollNumbers(ctx: AuthContext, academicSessionId: string) {
  authorizeAny(ctx, [...ROLL_PERMISSIONS]);
  const sections = await prisma.section.findMany({
    where: { academicSessionId },
    orderBy: [{ class: { displayOrder: "asc" } }, { class: { numericLevel: "asc" } }, { class: { name: "asc" } }, { name: "asc" }],
    take: 500,
    select: { id: true, name: true, code: true, capacity: true, isActive: true, class: { select: { name: true } }, rollNumberBatch: { select: { status: true, finalizedAt: true } } },
  });
  const counts = await activeEnrollmentCounts(prisma, sections.map((s) => s.id));
  return sections.map((s) => ({ ...s, enrolled: counts.get(s.id) ?? 0 }));
}

/**
 * One section's sheet: current numbers (if any) and the alphabetical preview — no writes (preview step).
 * S-12: the sheet lists students, so it also requires student.read at ALL scope, and the preview returns only
 * what the screen shows (no date of birth or internal student id).
 */
export async function getRollNumberSheet(ctx: AuthContext, sectionId: string) {
  authorizeAny(ctx, [...ROLL_PERMISSIONS]);
  if (authorize(ctx, "student.read") !== "ALL") throw new ForbiddenError();
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    select: { id: true, name: true, code: true, capacity: true, academicSessionId: true, class: { select: { name: true } }, academicSession: { select: { name: true, status: true } } },
  });
  if (!section) throw new NotFoundError("Section not found.");
  const batch = await prisma.rollNumberBatch.findUnique({
    where: { sectionId },
    select: {
      id: true,
      status: true,
      version: true,
      generatedAt: true,
      finalizedAt: true,
      generatedBy: { select: { displayName: true } },
      finalizedBy: { select: { displayName: true } },
      numbers: { orderBy: { rollNumber: "asc" }, select: { enrollmentId: true, rollNumber: true, source: true, enrollment: { select: { status: true, student: { select: { studentCode: true, fullName: true } } } } } },
    },
  });
  const current = await candidates(prisma, sectionId);
  const ordered = orderForRollNumbers(current);
  const draftIsCurrent = batch?.status === "DRAFT" ? draftMatchesCurrent(batch.numbers, current) : null;
  const preview = ordered.map((p) => ({ enrollmentId: p.enrollmentId, rollNumber: p.rollNumber, studentCode: p.studentCode, fullName: p.fullName }));
  return { section, batch, preview, draftIsCurrent };
}

// ───────────────────────────── Generate (DRAFT) ─────────────────────────────

/** (Re)generate the DRAFT for a section from its ACTIVE enrollments. Refused once FINALIZED. */
export async function generateRollNumbers(ctx: AuthContext, sectionId: string, version: number | null) {
  authorize(ctx, "rollnumber.generate");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      await lockForRollWrite(tx, sectionId);
      const batch = await lockBatch(tx, sectionId);
      if (batch?.status === "FINALIZED") throw new ConflictError("Roll numbers of this section are finalized. Use a correction instead.");
      if (batch && batch.version !== version) throw new ConflictError("The draft was changed by someone else. Reload the page and try again.");
      const ordered = orderForRollNumbers(await candidates(tx, sectionId));
      if (ordered.length === 0) throw new ConflictError("No active students in this section yet.");
      let batchId: string;
      let nextVersion: number;
      if (batch) {
        await tx.studentRollNumber.deleteMany({ where: { batchId: batch.id } });
        const updated = await tx.rollNumberBatch.update({ where: { id: batch.id }, data: { version: { increment: 1 }, generatedAt: new Date(), generatedById: ctx.userId }, select: { id: true, version: true } });
        [batchId, nextVersion] = [updated.id, updated.version];
      } else {
        const created = await tx.rollNumberBatch.create({ data: { sectionId, generatedById: ctx.userId }, select: { id: true, version: true } });
        [batchId, nextVersion] = [created.id, created.version];
      }
      await tx.studentRollNumber.createMany({ data: ordered.map((o) => ({ batchId, enrollmentId: o.enrollmentId, rollNumber: o.rollNumber, source: "GENERATED" as const })) });
      await audit(tx, actorOf(ctx), { action: "rollnumber.generate", entityType: "RollNumberBatch", entityId: batchId, after: { sectionId, status: "DRAFT", count: ordered.length, version: nextVersion } });
      return { batchId, count: ordered.length, version: nextVersion };
    });
  } catch (e) {
    mapBusy(e);
  }
}

// ───────────────────────────── Finalize ─────────────────────────────

/** DRAFT → FINALIZED (type the section code). The draft must still equal a fresh generation. */
export async function finalizeRollNumbers(ctx: AuthContext, sectionId: string, version: number, confirm: string) {
  authorize(ctx, "rollnumber.finalize");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const section = await lockForRollWrite(tx, sectionId);
      assertFinalizeConfirmation(confirm, section.code);
      const batch = await lockBatch(tx, sectionId);
      if (!batch) throw new ConflictError("Generate the draft first.");
      if (batch.status === "FINALIZED") throw new ConflictError("Roll numbers of this section are already finalized.");
      if (batch.version !== version) throw new ConflictError("The draft was changed by someone else. Reload the page and try again.");
      const draft = await tx.studentRollNumber.findMany({ where: { batchId: batch.id }, select: { enrollmentId: true, rollNumber: true } });
      if (!draftMatchesCurrent(draft, await candidates(tx, sectionId))) {
        throw new ConflictError("Students or names changed since the draft was generated. Generate the draft again, check it, then finalize.");
      }
      await tx.rollNumberBatch.update({ where: { id: batch.id }, data: { status: "FINALIZED", finalizedAt: new Date(), finalizedById: ctx.userId, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "rollnumber.finalize", entityType: "RollNumberBatch", entityId: batch.id, after: { sectionId, status: "FINALIZED", count: draft.length } });
      return { batchId: batch.id, count: draft.length };
    });
  } catch (e) {
    mapBusy(e);
  }
}

// ───────────────────────────── Append (inside approval) ─────────────────────────────

/**
 * Called INSIDE the approval transaction right after the enrollment is created (the section row is already
 * locked by the approval). In a FINALIZED section the new student gets max + 1 (never a reused number); a
 * DRAFT or missing batch is left alone (the next generation includes the student; a stale draft can't be
 * finalized). Returns the appended number or null.
 */
export async function appendRollNumberOnEnrollment(tx: Tx, actor: AuditActor, sectionId: string, enrollmentId: string): Promise<number | null> {
  const batch = await lockBatch(tx, sectionId);
  if (!batch || batch.status !== "FINALIZED") return null;
  const numbers = await tx.studentRollNumber.findMany({ where: { batchId: batch.id }, select: { rollNumber: true } });
  const rollNumber = nextAppendedNumber(numbers.map((n) => n.rollNumber));
  await tx.studentRollNumber.create({ data: { batchId: batch.id, enrollmentId, rollNumber, source: "APPENDED" } });
  await audit(tx, actor, { action: "rollnumber.append", entityType: "RollNumberBatch", entityId: batch.id, after: { sectionId, enrollmentId, rollNumber } });
  return rollNumber;
}

// ───────────────────────────── Correct ─────────────────────────────

/** Move one student to a free number in a FINALIZED section, with a mandatory reason (audited before/after). */
export async function correctRollNumber(ctx: AuthContext, input: { sectionId: string; enrollmentId: string; rollNumber: number; reason: string; version: number }) {
  authorize(ctx, "rollnumber.correct");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      await lockForRollWrite(tx, input.sectionId);
      const batch = await lockBatch(tx, input.sectionId);
      if (!batch) throw new NotFoundError("No roll numbers in this section yet.");
      if (batch.version !== input.version) throw new ConflictError("Roll numbers were changed by someone else. Reload the page and try again.");
      const row = await tx.studentRollNumber.findFirst({ where: { batchId: batch.id, enrollmentId: input.enrollmentId }, select: { id: true, rollNumber: true } });
      if (!row) throw new NotFoundError("This student has no roll number in this section.");
      const taken = await tx.studentRollNumber.findFirst({ where: { batchId: batch.id, rollNumber: input.rollNumber }, select: { enrollmentId: true } });
      assertCorrection({ batchStatus: batch.status, current: row.rollNumber, target: input.rollNumber, takenBy: taken?.enrollmentId ?? null, enrollmentId: input.enrollmentId });
      await tx.studentRollNumber.update({ where: { id: row.id }, data: { rollNumber: input.rollNumber, source: "CORRECTED" } });
      await tx.rollNumberBatch.update({ where: { id: batch.id }, data: { version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), {
        action: "rollnumber.correct",
        entityType: "RollNumberBatch",
        entityId: batch.id,
        before: { enrollmentId: input.enrollmentId, rollNumber: row.rollNumber },
        after: { enrollmentId: input.enrollmentId, rollNumber: input.rollNumber, reason: input.reason },
      });
    });
  } catch (e) {
    mapBusy(e);
  }
}
