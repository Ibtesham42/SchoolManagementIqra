import { z } from "zod";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { portalAccountsOfGuardiansTx } from "@/modules/identity/portal-accounts.tx";

/**
 * Phase 6A-M3b (P18, closes KI-057 (3)) — the same parent recorded twice (one Guardian row per admission) means one
 * portal account can't see every sibling. The office can:
 *  - link an EXISTING guardian to a student (found by mobile number), and
 *  - merge two guardian records that share a mobile number into one (links, pending-application references and
 *    portal blocks move to the kept record; the other is soft-deleted).
 *
 * Both change what a parent's portal account can see, so they need `portal.account.manage` + `student.update` +
 * `student.read`, all at ALL (School Admin; Super Admin). Merge is refused when the record being removed has a portal
 * account (merge the other way round; with two accounts the office deactivates one and merges into the other).
 * Lock order (§2.6): every affected student FOR UPDATE ORDER BY id → the guardian rows FOR UPDATE ORDER BY id.
 * Audited; no contact data in the audit rows.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const id = z.string().min(1).max(64);
const relation = z.enum(["FATHER", "MOTHER", "GUARDIAN", "OTHER"]);

export const guardianSearchSchema = z.object({ studentId: id, phone: z.string().trim().regex(/^\d{10}$/, "Enter the 10-digit mobile number.") }).strict();
export const linkGuardianSchema = z.object({ studentId: id, guardianId: id, relation }).strict();
/** Review 6A-M3b L2: records with different names need an explicit confirmation (shared household phones). */
export const mergeGuardiansSchema = z.object({ studentId: id, keepGuardianId: id, removeGuardianId: id, confirmDifferent: z.boolean().default(false) }).strict();

export function canLinkGuardians(ctx: AuthContext): boolean {
  return (["portal.account.manage", "student.update", "student.read"] as const).every((k) => hasPermission(ctx, k) && scopeFor(ctx, k) === "ALL");
}

function assertLinker(ctx: AuthContext) {
  for (const k of ["portal.account.manage", "student.update", "student.read"] as const) if (authorize(ctx, k) !== "ALL") throw new ForbiddenError();
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

async function lockRows(tx: Tx, table: "student" | "guardian", ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows =
    table === "student"
      ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM student WHERE id = ANY(${unique}) AND deleted_at IS NULL ORDER BY id FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM guardian WHERE id = ANY(${unique}) AND deleted_at IS NULL ORDER BY id FOR UPDATE`;
  if (rows.length !== unique.length) throw new NotFoundError(table === "student" ? "Student not found." : "Guardian not found.");
}

/** Locks students by id whether or not they are soft-deleted (merge moves every link of the removed record). */
async function lockAnyStudents(tx: Tx, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM student WHERE id = ANY(${unique}) ORDER BY id FOR UPDATE`;
  if (rows.length !== unique.length) throw new NotFoundError("Student not found.");
}

/** Guardian records with this mobile number (≤ 10), with their students, whether they are already linked here and have an account. */
export async function findGuardiansByPhone(ctx: AuthContext, input: z.infer<typeof guardianSearchSchema>) {
  assertLinker(ctx);
  const student = await prisma.student.findFirst({ where: { id: input.studentId, deletedAt: null }, select: { id: true, guardians: { select: { guardianId: true } } } });
  if (!student) throw new NotFoundError("Student not found.");
  const linked = new Set(student.guardians.map((g) => g.guardianId));
  const rows = await prisma.guardian.findMany({
    where: { phone: input.phone, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 10,
    select: { id: true, name: true, students: { where: { student: { deletedAt: null } }, take: 10, select: { studentId: true, relation: true, portalAccess: true, student: { select: { studentCode: true, fullName: true } } } } },
  });
  const accounts = await portalAccountsOfGuardiansTx(prisma, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    // Review 6A-M3b L6: the caller typed the number; only its last 4 digits are echoed back.
    phoneHint: `••••••${input.phone.slice(-4)}`,
    relationHere: r.students.find((s) => s.studentId === input.studentId)?.relation ?? null,
    linkedHere: linked.has(r.id),
    /** Review 6A-M3b H1: shown so the office sees a custody block before linking or merging. */
    blockedHere: r.students.some((s) => s.studentId === input.studentId && !s.portalAccess),
    hasAccount: accounts.has(r.id),
    students: r.students.map((s) => `${s.student.studentCode} — ${s.student.fullName}`),
  }));
}

/** Link an existing guardian to this student (not primary; the guardian's portal account sees the student from its next request). */
export async function linkGuardianToStudent(ctx: AuthContext, input: z.infer<typeof linkGuardianSchema>): Promise<{ portalAccess: boolean }> {
  assertLinker(ctx);
  return prisma.$transaction(async (tx) => {
    await lockTimeout(tx);
    await lockRows(tx, "student", [input.studentId]);
    await lockRows(tx, "guardian", [input.guardianId]);
    const existing = await tx.studentGuardian.findUnique({ where: { studentId_guardianId: { studentId: input.studentId, guardianId: input.guardianId } }, select: { studentId: true } });
    if (existing) throw new ConflictError("This guardian is already linked to this student.");
    const current = await tx.studentGuardian.findMany({ where: { studentId: input.studentId }, take: 10, select: { portalAccess: true, guardian: { select: { phone: true, deletedAt: true } } } });
    if (current.length >= 6) throw new ValidationError("A student can have at most 6 guardians.");
    const guardian = await tx.guardian.findUniqueOrThrow({ where: { id: input.guardianId }, select: { phone: true } });
    // Review 6A-M3b H1: the same-person rule of admission links — only a record sharing the mobile number of one of
    // this student's guardians (a typo or a crafted request can't attach a stranger) …
    if (!current.some((c) => !c.guardian.deletedAt && c.guardian.phone === guardian.phone)) {
      throw new ValidationError("Only a record with the same mobile number as one of this student's guardians can be linked. Correct the number first if it is the same person.");
    }
    // … and never a way around a custody block (P24): while any guardian of this student is blocked, a new link
    // starts blocked too; the office unblocks it explicitly (audited) if that is right.
    const portalAccess = !current.some((c) => !c.portalAccess);
    await tx.studentGuardian.create({ data: { studentId: input.studentId, guardianId: input.guardianId, relation: input.relation, isPrimary: false, isEmergencyContact: false, portalAccess } });
    await audit(tx, actorOf(ctx), { action: "guardian.link", entityType: "Student", entityId: input.studentId, after: { guardianId: input.guardianId, relation: input.relation, portalAccess } });
    return { portalAccess };
  });
}

/**
 * Merge `removeGuardianId` into `keepGuardianId` (same mobile number; at least one of them linked to `studentId`, the
 * screen it was started from). Per student of the removed record: a new link to the kept one with the same relation /
 * primary / emergency flags, or — if the kept one is already linked — the flags combined (primary if either was;
 * portal view only if BOTH allowed it, so a block is never lost). Pending admission applications that pointed at the
 * removed record point at the kept one (decided applications keep their history). The removed record is soft-deleted.
 * Different names need `confirmDifferent` (one phone is often shared by both parents).
 */
export async function mergeGuardians(ctx: AuthContext, input: z.infer<typeof mergeGuardiansSchema>): Promise<{ movedLinks: number }> {
  assertLinker(ctx);
  if (input.keepGuardianId === input.removeGuardianId) throw new ValidationError("Choose two different guardian records.");
  return prisma.$transaction(async (tx) => {
    await lockTimeout(tx);
    const pair = await tx.guardian.findMany({ where: { id: { in: [input.keepGuardianId, input.removeGuardianId] }, deletedAt: null }, select: { id: true, phone: true } });
    if (pair.length !== 2) throw new NotFoundError("Guardian not found.");
    const links = await tx.studentGuardian.findMany({ where: { guardianId: { in: [input.keepGuardianId, input.removeGuardianId] } }, select: { studentId: true } });
    if (!links.some((l) => l.studentId === input.studentId)) throw new NotFoundError("Guardian not found.");
    // Review 6A-M3b M3: every affected student is locked — soft-deleted ones too (their links move with the rest).
    const lockedStudents = new Set([input.studentId, ...links.map((l) => l.studentId)]);
    await lockAnyStudents(tx, [...lockedStudents]);
    await lockRows(tx, "guardian", [input.keepGuardianId, input.removeGuardianId]);
    // Re-read under the locks.
    const [keep, remove] = await Promise.all(
      [input.keepGuardianId, input.removeGuardianId].map((gid) =>
        tx.guardian.findUniqueOrThrow({ where: { id: gid }, select: { id: true, name: true, phone: true, students: { select: { studentId: true, relation: true, isPrimary: true, isEmergencyContact: true, portalAccess: true } } } }),
      ),
    );
    if ([...keep.students, ...remove.students].some((l) => !lockedStudents.has(l.studentId))) throw new ConflictError("These records changed while merging. Please try again.");
    if (keep.phone !== remove.phone) throw new ValidationError("Only records with the same mobile number can be merged. Correct the number first if it is the same person.");
    // Review 6A-M3b L2: one household phone is often shared by both parents (father and mother) — records with different
    // names need an explicit confirmation that they are the same person. Moved links keep their own relation.
    const different = keep.name.trim().toLowerCase() !== remove.name.trim().toLowerCase();
    if (different && !input.confirmDifferent) throw new ValidationError("These records have different names. Confirm that they are the same person.", [{ path: "confirmDifferent", message: "Confirmation needed." }]);
    const accounts = await portalAccountsOfGuardiansTx(tx, [keep.id, remove.id]);
    if (accounts.has(remove.id)) {
      throw new ConflictError(accounts.has(keep.id) ? "Both records have a portal account. Deactivate one account, then merge into the record that keeps its account." : "The record being removed has the portal account. Merge the other way round.");
    }
    const kept = new Map(keep.students.map((l) => [l.studentId, l]));
    const changes: { studentId: string; before: { keep: { primary: boolean; portal: boolean } | null; remove: { primary: boolean; portal: boolean } }; after: { primary: boolean; portal: boolean } }[] = [];
    for (const l of remove.students) {
      await tx.studentGuardian.delete({ where: { studentId_guardianId: { studentId: l.studentId, guardianId: remove.id } } });
      const k = kept.get(l.studentId);
      if (k) {
        await tx.studentGuardian.update({
          where: { studentId_guardianId: { studentId: l.studentId, guardianId: keep.id } },
          data: { isPrimary: k.isPrimary || l.isPrimary, isEmergencyContact: k.isEmergencyContact || l.isEmergencyContact, portalAccess: k.portalAccess && l.portalAccess },
        });
        changes.push({ studentId: l.studentId, before: { keep: { primary: k.isPrimary, portal: k.portalAccess }, remove: { primary: l.isPrimary, portal: l.portalAccess } }, after: { primary: k.isPrimary || l.isPrimary, portal: k.portalAccess && l.portalAccess } });
      } else {
        await tx.studentGuardian.create({ data: { studentId: l.studentId, guardianId: keep.id, relation: l.relation, isPrimary: l.isPrimary, isEmergencyContact: l.isEmergencyContact, portalAccess: l.portalAccess } });
        changes.push({ studentId: l.studentId, before: { keep: null, remove: { primary: l.isPrimary, portal: l.portalAccess } }, after: { primary: l.isPrimary, portal: l.portalAccess } });
      }
    }
    // Review 6A-M3b L3: only applications still being worked on; decided ones keep their history. (Approval itself
    // takes the linked guardian FOR SHARE, waits for this merge and then refuses the removed record.)
    const apps = await tx.admissionGuardian.updateMany({ where: { linkGuardianId: remove.id, application: { status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] } } }, data: { linkGuardianId: keep.id } });
    await tx.guardian.update({ where: { id: remove.id }, data: { deletedAt: new Date() } });
    await audit(tx, actorOf(ctx), {
      action: "guardian.merge",
      entityType: "Guardian",
      entityId: keep.id,
      // Review 6A-M3b L1: per student, the primary / portal flags before and after (no contact data).
      after: { removedGuardianId: remove.id, movedLinks: remove.students.length, links: changes, applications: apps.count, keptHasAccount: accounts.has(keep.id), confirmedDifferent: different },
    });
    return { movedLinks: remove.students.length };
  });
}
