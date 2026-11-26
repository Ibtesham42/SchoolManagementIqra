import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { assertSessionWritable } from "@/modules/academic/academic.rules";
import { lockSessionShared } from "@/modules/academic/academic.tx";
import { confirmTimingProblem, decisionProblem, nextClassFor, targetSessionProblem, type ClassOption } from "@/modules/academic/promotion.rules";
import { readAdmissionSettings } from "@/modules/settings/settings.service";
import type { ConfirmPromotionsInput, ProposePromotionsInput } from "./promotion.schemas";
import { deactivateStudentAccountOnLeavingTx } from "./family-accounts.service";

/**
 * Phase 4C-M1 — promotion at session end (PHASE_4_PLAN.md AC16; KI-080).
 *
 * - Propose PROMOTE / DETAIN / LEAVE per student: the section's class teacher (`academic.read` ASSIGNED, own section,
 *   open session) or a `student.promote` holder. Proposals can change until confirmed.
 * - Confirm a section in bulk: `student.promote` (School Admin), from the session's last day. One transaction:
 *   PROMOTE / DETAIN → a new ACTIVE enrollment in the chosen next-session section (capacity checked under the section
 *   lock); the old enrollment becomes PROMOTED / DETAINED with leftOn = session end. LEAVE → old enrollment LEFT and the
 *   student's status TRANSFERRED / WITHDRAWN / GRADUATED with an append-only status-change row. Old enrollments are
 *   otherwise untouched; roll numbers are generated in the new session as usual.
 * - Out-of-scope sections answer NotFound.
 * Lock order (same first locks as students.changeStudentStatus): student FOR UPDATE (by id) → academic_session FOR SHARE
 * (source, then target) → section FOR UPDATE (source, then targets by id) → promotion_decision FOR UPDATE.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const busy = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new ConflictError("Someone else just saved promotions for this section. Reload the page and try again.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};
type Db = Tx | typeof prisma;

async function sectionFacts(db: Db, sectionId: string) {
  const s = await db.section.findUnique({
    where: { id: sectionId },
    select: {
      id: true,
      code: true,
      classTeacherId: true,
      academicSessionId: true,
      class: { select: { id: true, name: true, numericLevel: true, displayOrder: true, isActive: true } },
      academicSession: { select: { id: true, name: true, status: true, startDate: true, endDate: true } },
    },
  });
  if (!s) throw new NotFoundError("Section not found.");
  return s;
}
type SectionFacts = Awaited<ReturnType<typeof sectionFacts>>;

export function promotionAccess(ctx: AuthContext, s: { classTeacherId: string | null; sessionStatus: string }) {
  const confirm = hasPermission(ctx, "student.promote");
  const academic = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  const classTeacher = academic === "ASSIGNED" && s.classTeacherId === ctx.userId && s.sessionStatus !== "CLOSED";
  return { propose: confirm || classTeacher, confirm };
}

const classOptions = (db: Db) =>
  db.schoolClass.findMany({ where: { isActive: true }, orderBy: [{ numericLevel: "asc" }, { displayOrder: "asc" }], take: 100, select: { id: true, name: true, numericLevel: true, displayOrder: true, isActive: true } });

const rosterWhere = (sectionId: string) => ({ sectionId, status: "ACTIVE" as const, student: { deletedAt: null, status: "ACTIVE" as const } });

/** Sections the caller may open on the promotion screen. */
export async function listPromotionSections(ctx: AuthContext, academicSessionId: string) {
  const academic = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  if (!hasPermission(ctx, "student.promote") && academic !== "ASSIGNED") throw new ForbiddenError();
  return prisma.section.findMany({
    where: { academicSessionId, ...(hasPermission(ctx, "student.promote") ? {} : { classTeacherId: ctx.userId, academicSession: { status: { not: "CLOSED" } } }) },
    orderBy: [{ class: { displayOrder: "asc" } }, { code: "asc" }],
    take: 300,
    select: { id: true, code: true },
  });
}

/** The section's students with their proposals, the class choices, and (for confirmers) the next sessions and sections. */
export async function getSectionPromotion(ctx: AuthContext, sectionId: string, targetSessionId?: string) {
  const s = await sectionFacts(prisma, sectionId);
  const access = promotionAccess(ctx, { classTeacherId: s.classTeacherId, sessionStatus: s.academicSession.status });
  if (!access.propose) throw new NotFoundError("Section not found.");
  const [roster, classes, settings] = await Promise.all([
    prisma.studentEnrollment.findMany({
      where: { sectionId: s.id, OR: [rosterWhere(s.id), { promotionFrom: { isNot: null } }] },
      orderBy: [{ rollNumber: { rollNumber: "asc" } }, { student: { fullNameNormalized: "asc" } }, { id: "asc" }],
      take: 200,
      select: {
        id: true,
        status: true,
        rollNumber: { select: { rollNumber: true } },
        student: { select: { studentCode: true, fullName: true } },
        promotionFrom: { select: { decision: true, toClassId: true, leaveAs: true, status: true, version: true, toClass: { select: { name: true } } } },
      },
    }),
    classOptions(prisma),
    prisma.$transaction((tx) => readAdmissionSettings(tx)),
  ]);
  const next = nextClassFor(classes, s.class as ClassOption);
  const nextClasses = next.kind === "one" ? classes.filter((c) => c.id === next.classId) : next.kind === "choose" ? classes.filter((c) => next.classIds.includes(c.id)) : [];
  const today = todayInTimeZone(settings.timezone ?? undefined);
  const sessionEnd = iso(s.academicSession.endDate);
  const targetSessions = access.confirm
    ? await prisma.academicSession.findMany({ where: { status: { not: "CLOSED" }, startDate: { gt: s.academicSession.endDate } }, orderBy: { startDate: "asc" }, take: 5, select: { id: true, name: true } })
    : [];
  const target = targetSessions.find((t) => t.id === targetSessionId) ?? targetSessions[0] ?? null;
  const targetSections = target
    ? await prisma.section.findMany({
        where: { academicSessionId: target.id, isActive: true, classId: { in: [s.class.id, ...nextClasses.map((c) => c.id)] } },
        orderBy: [{ class: { displayOrder: "asc" } }, { code: "asc" }],
        take: 100,
        select: { id: true, code: true, classId: true, capacity: true, _count: { select: { enrollments: { where: { status: "ACTIVE" } } } } },
      })
    : [];
  const pending = roster.filter((r) => r.promotionFrom?.status === "PROPOSED").length;
  return {
    section: { id: s.id, code: s.code, className: s.class.name, classId: s.class.id, sessionName: s.academicSession.name, sessionEnd, closed: s.academicSession.status === "CLOSED" },
    access,
    next: next.kind,
    nextClasses: nextClasses.map((c) => ({ id: c.id, name: c.name })),
    rows: roster.map((r) => ({
      enrollmentId: r.id,
      rollNumber: r.rollNumber?.rollNumber ?? null,
      studentCode: r.student.studentCode,
      fullName: r.student.fullName,
      editable: r.status === "ACTIVE" && r.promotionFrom?.status !== "CONFIRMED",
      decision: r.promotionFrom ? { ...r.promotionFrom, toClassName: r.promotionFrom.toClass?.name ?? null } : null,
    })),
    pending,
    confirmBlocker: confirmTimingProblem(today, sessionEnd),
    targetSessions,
    targetSession: target,
    targetSections: targetSections.map((t) => ({ id: t.id, code: t.code, classId: t.classId, capacity: t.capacity, active: t._count.enrollments })),
  };
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

export async function proposePromotions(ctx: AuthContext, input: ProposePromotionsInput) {
  if (!hasPermission(ctx, "student.promote") && !hasPermission(ctx, "academic.read")) throw new ForbiddenError();
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const peek = await sectionFacts(tx, input.sectionId);
      if (!promotionAccess(ctx, { classTeacherId: peek.classTeacherId, sessionStatus: peek.academicSession.status }).propose) throw new NotFoundError("Section not found.");
      assertSessionWritable(await lockSessionShared(tx, peek.academicSessionId));
      await tx.$queryRaw`SELECT id FROM section WHERE id = ${peek.id} FOR SHARE`;
      const s = await sectionFacts(tx, input.sectionId);
      if (!promotionAccess(ctx, { classTeacherId: s.classTeacherId, sessionStatus: s.academicSession.status }).propose) throw new NotFoundError("Section not found.");
      const classes = await classOptions(tx);
      const roster = new Map((await tx.studentEnrollment.findMany({ where: rosterWhere(s.id), take: 200, select: { id: true, student: { select: { fullName: true } } } })).map((r) => [r.id, r.student.fullName]));
      const ids = input.entries.map((e) => e.enrollmentId).sort();
      const existing = new Map(
        (await tx.$queryRaw<{ id: string; from_enrollment_id: string; status: string; version: number }[]>`
          SELECT id, from_enrollment_id, status::text AS status, version FROM promotion_decision WHERE from_enrollment_id = ANY(${ids}) ORDER BY from_enrollment_id FOR UPDATE`).map((r) => [r.from_enrollment_id, r]),
      );
      const issues: { path: string; message: string }[] = [];
      let created = 0;
      let changed = 0;
      for (const e of input.entries) {
        const name = roster.get(e.enrollmentId);
        if (!name) throw new NotFoundError("A student on this list is no longer active in this section. Reload the page.");
        const cur = existing.get(e.enrollmentId);
        if ((cur?.version ?? null) !== e.version) throw new ConflictError("These promotions were changed by someone else. Reload the page and try again.");
        if (cur?.status === "CONFIRMED") throw new ConflictError(`${name}'s promotion is already confirmed.`);
        const d = decisionProblem(classes, s.class as ClassOption, e);
        if (!d.ok) {
          issues.push({ path: `entries.${e.enrollmentId}`, message: `${name}: ${d.message}` });
          continue;
        }
        const data = { decision: e.decision, toClassId: d.classId, leaveAs: e.decision === "LEAVE" ? e.leaveAs : null, proposedById: ctx.userId, proposedAt: new Date() };
        if (cur) {
          await tx.promotionDecision.update({ where: { id: cur.id }, data: { ...data, version: { increment: 1 } } });
          changed += 1;
        } else {
          await tx.promotionDecision.create({ data: { ...data, academicSessionId: s.academicSessionId, fromEnrollmentId: e.enrollmentId } });
          created += 1;
        }
      }
      if (issues.length > 0) throw new ValidationError(issues[0].message, issues.slice(0, 20));
      await audit(tx, actorOf(ctx), { action: "promotion.propose", entityType: "Section", entityId: s.id, after: { created, changed, academicSessionId: s.academicSessionId } });
      return { created, changed };
    });
  } catch (e) {
    return busy(e);
  }
}

/** Confirms every PROPOSED decision of the section (`student.promote`), from the session's last day. */
export async function confirmPromotions(ctx: AuthContext, input: ConfirmPromotionsInput) {
  if (!hasPermission(ctx, "student.promote")) throw new ForbiddenError();
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockTimeout(tx);
        const peek = await sectionFacts(tx, input.sectionId);
        // Students first (same first lock as changeStudentStatus), then sessions, then sections.
        const peekRows = await tx.studentEnrollment.findMany({ where: { sectionId: peek.id, status: "ACTIVE", student: { deletedAt: null }, promotionFrom: { is: { status: "PROPOSED" } } }, take: 201, select: { studentId: true } });
        if (peekRows.length > 200) throw new ConflictError("A section has at most 200 students to confirm at once.");
        const studentIds = [...new Set(peekRows.map((r) => r.studentId))].sort();
        if (studentIds.length === 0) throw new ConflictError("No proposed promotions to confirm in this section.");
        await tx.$queryRaw`SELECT id FROM student WHERE id = ANY(${studentIds}) AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
        assertSessionWritable(await lockSessionShared(tx, peek.academicSessionId));
        const targetStatus = await lockSessionShared(tx, input.targetSessionId);
        const target = await tx.academicSession.findUniqueOrThrow({ where: { id: input.targetSessionId }, select: { id: true, name: true, startDate: true } });
        const s = await sectionFacts(tx, input.sectionId);
        const sp = targetSessionProblem({ endDate: iso(s.academicSession.endDate) }, { startDate: iso(target.startDate), status: targetStatus });
        if (sp) throw new ConflictError(sp);
        const { timezone } = await readAdmissionSettings(tx);
        const tp = confirmTimingProblem(todayInTimeZone(timezone ?? undefined), iso(s.academicSession.endDate));
        if (tp) throw new ConflictError(tp);
        await tx.$queryRaw`SELECT id FROM section WHERE id = ${s.id} FOR UPDATE`;
        const targetIds = [...new Set(input.targets.map((t) => t.sectionId))].sort();
        if (targetIds.length) await tx.$queryRaw`SELECT id FROM section WHERE id = ANY(${targetIds}) ORDER BY id FOR UPDATE`;
        const targetSections = await tx.section.findMany({ where: { id: { in: targetIds } }, select: { id: true, code: true, classId: true, academicSessionId: true, isActive: true, capacity: true } });
        const sectionFor = new Map<string, (typeof targetSections)[number]>();
        for (const t of input.targets) {
          const ts = targetSections.find((x) => x.id === t.sectionId);
          if (!ts || ts.academicSessionId !== target.id || ts.classId !== t.classId) throw new NotFoundError("A chosen section doesn't belong to that class in the next session. Reload the page.");
          if (!ts.isActive) throw new ConflictError(`Section ${ts.code} is inactive.`);
          sectionFor.set(t.classId, ts);
        }

        const decisions = await tx.$queryRaw<{ id: string; from_enrollment_id: string; decision: "PROMOTE" | "DETAIN" | "LEAVE"; to_class_id: string | null; leave_as: "TRANSFERRED" | "WITHDRAWN" | "GRADUATED" | null; version: number }[]>`
          SELECT d.id, d.from_enrollment_id, d.decision::text AS decision, d.to_class_id, d.leave_as::text AS leave_as, d.version
          FROM promotion_decision d JOIN student_enrollment e ON e.id = d.from_enrollment_id
          JOIN student st ON st.id = e.student_id AND st.deleted_at IS NULL
          WHERE e.section_id = ${s.id} AND e.status = 'ACTIVE' AND d.status = 'PROPOSED' ORDER BY d.id LIMIT 201 FOR UPDATE OF d`;
        if (decisions.length > 200) throw new ConflictError("A section has at most 200 students to confirm at once.");
        const enrollments = new Map(
          (
            await tx.studentEnrollment.findMany({
              where: { id: { in: decisions.map((d) => d.from_enrollment_id) } },
              select: { id: true, studentId: true, student: { select: { fullName: true, status: true, version: true } } },
            })
          ).map((e) => [e.id, e]),
        );
        // Review 4C M1: a proposal committed between the peek and the section lock names a student we didn't lock.
        const locked = new Set(studentIds);
        if ([...enrollments.values()].some((e) => !locked.has(e.studentId))) throw new ConflictError("Proposals changed while confirming. Reload the page and try again.");
        const classes = await classOptions(tx);
        const already = new Set(
          (await tx.studentEnrollment.findMany({ where: { academicSessionId: target.id, studentId: { in: [...enrollments.values()].map((e) => e.studentId) } }, select: { studentId: true } })).map((e) => e.studentId),
        );
        const incoming = new Map<string, number>();
        for (const d of decisions) {
          const e = enrollments.get(d.from_enrollment_id)!;
          if (e.student.status !== "ACTIVE") throw new ConflictError(`${e.student.fullName} is no longer an active student. Change their proposal first.`);
          // Re-check the rule with today's classes (a class may have been deactivated since the proposal).
          const check = decisionProblem(classes, s.class as ClassOption, { decision: d.decision, toClassId: d.to_class_id, leaveAs: d.leave_as });
          if (!check.ok) throw new ConflictError(`${e.student.fullName}: ${check.message}`);
          if (d.decision === "LEAVE") continue;
          if (already.has(e.studentId)) throw new ConflictError(`${e.student.fullName} is already enrolled in ${target.name}.`);
          const ts = sectionFor.get(check.classId!);
          if (!ts) throw new ValidationError("Choose a section in the next session for every class students move to.", [{ path: "targets", message: "Choose a section for each class." }]);
          incoming.set(ts.id, (incoming.get(ts.id) ?? 0) + 1);
        }
        for (const [id, n] of incoming) {
          const ts = targetSections.find((x) => x.id === id)!;
          const active = await tx.studentEnrollment.count({ where: { sectionId: id, status: "ACTIVE" } });
          if (active + n > ts.capacity) throw new ConflictError(`Section ${ts.code} has room for ${Math.max(0, ts.capacity - active)} more, but ${n} would join. Choose another section or raise its capacity.`);
        }

        const sessionEnd = s.academicSession.endDate;
        const now = new Date();
        let promoted = 0;
        let detained = 0;
        let left = 0;
        for (const d of decisions) {
          const e = enrollments.get(d.from_enrollment_id)!;
          if (d.decision === "LEAVE") {
            await tx.studentEnrollment.update({ where: { id: e.id }, data: { status: "LEFT", leftOn: sessionEnd } });
            const r = await tx.student.updateMany({ where: { id: e.studentId, version: e.student.version, status: "ACTIVE" }, data: { status: d.leave_as!, version: { increment: 1 } } });
            if (r.count !== 1) throw new ConflictError(`${e.student.fullName}'s record changed meanwhile. Reload the page and try again.`);
            // Phase 6C-M4 (P17): leaving at session end ends the student's own portal account in this transaction.
            await deactivateStudentAccountOnLeavingTx(tx, actorOf(ctx), e.studentId);
            const change = await tx.studentStatusChange.create({
              data: { studentId: e.studentId, fromStatus: "ACTIVE", toStatus: d.leave_as!, reason: `Session-end decision: left after ${s.academicSession.name}.`, effectiveDate: sessionEnd, actedById: ctx.userId },
              select: { id: true },
            });
            await tx.promotionDecision.update({ where: { id: d.id }, data: { status: "CONFIRMED", confirmedById: ctx.userId, confirmedAt: now, version: { increment: 1 } } });
            await audit(tx, actorOf(ctx), { action: "student.status_change", entityType: "Student", entityId: e.studentId, before: { status: "ACTIVE" }, after: { status: d.leave_as, effectiveDate: iso(sessionEnd), statusChangeId: change.id, enrollmentsLeft: [e.id], via: "promotion" } });
            left += 1;
            continue;
          }
          const ts = sectionFor.get(d.to_class_id!)!;
          // Review 4C M1: version bump under the student lock — a status change that read the old version must reload.
          const bumped = await tx.student.updateMany({ where: { id: e.studentId, version: e.student.version, status: "ACTIVE", deletedAt: null }, data: { version: { increment: 1 } } });
          if (bumped.count !== 1) throw new ConflictError(`${e.student.fullName}'s record changed meanwhile. Reload the page and try again.`);
          const next = await tx.studentEnrollment.create({ data: { studentId: e.studentId, academicSessionId: target.id, sectionId: ts.id, status: "ACTIVE", enrolledOn: target.startDate }, select: { id: true } });
          await tx.studentEnrollment.update({ where: { id: e.id }, data: { status: d.decision === "PROMOTE" ? "PROMOTED" : "DETAINED", leftOn: sessionEnd } });
          await tx.promotionDecision.update({ where: { id: d.id }, data: { status: "CONFIRMED", confirmedById: ctx.userId, confirmedAt: now, toEnrollmentId: next.id, version: { increment: 1 } } });
          await audit(tx, actorOf(ctx), {
            action: "enrollment.create",
            entityType: "StudentEnrollment",
            entityId: next.id,
            after: { studentId: e.studentId, academicSessionId: target.id, sectionId: ts.id, status: "ACTIVE", fromEnrollmentId: e.id, decision: d.decision },
          });
          if (d.decision === "PROMOTE") promoted += 1;
          else detained += 1;
        }
        await audit(tx, actorOf(ctx), { action: "promotion.confirm", entityType: "Section", entityId: s.id, after: { targetSessionId: target.id, promoted, detained, left } });
        return { promoted, detained, left };
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    return busy(e);
  }
}
