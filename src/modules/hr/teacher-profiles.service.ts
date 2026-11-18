import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { employeeReadAccess, employeeRecordAccess } from "./hr.policy";
import type { TeacherProfileInput } from "./hr.schemas";

/**
 * Teacher profiles (Phase 3A M3, H14): qualifications, professional qualifications (B.Ed, CTET…), subject
 * specialisations as free text (mapped to Phase 4 subjects later), prior experience, registration number.
 * One per TEACHING employee (service rule — the employee row is locked while it is checked). Professional
 * data, not personal-tier (H6): readable by every directory reader; writes need `employee.manage`.
 * Audit rows record which fields changed, not their values (qualification text can be long free text).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });

export const TEACHER_PROFILE_SELECT = {
  version: true,
  qualifications: true,
  professionalQualifications: true,
  specializations: true,
  experienceYearsBefore: true,
  teacherRegistrationNo: true,
  updatedAt: true,
} satisfies Prisma.TeacherProfileSelect;

export async function getTeacherProfile(ctx: AuthContext, employeeId: string) {
  employeeRecordAccess(ctx, employeeId);
  return prisma.teacherProfile.findFirst({ where: { employeeId, employee: { deletedAt: null } }, select: TEACHER_PROFILE_SELECT });
}

async function lockTeachingEmployee(tx: Tx, employeeId: string) {
  const [row] = await tx.$queryRaw<{ staff_type: string }[]>`SELECT staff_type::text AS staff_type FROM employee WHERE id = ${employeeId} AND deleted_at IS NULL FOR UPDATE`;
  if (!row) throw new NotFoundError("Employee not found.");
  if (row.staff_type !== "TEACHING") throw new ConflictError("Teacher profiles are only for teaching staff.");
}

/** Create (version null) or update (optimistic version) in one transaction with the employee row locked. */
export async function saveTeacherProfile(ctx: AuthContext, input: TeacherProfileInput) {
  authorize(ctx, "employee.manage");
  employeeReadAccess(ctx);
  const data = {
    qualifications: input.qualifications as Prisma.InputJsonValue,
    professionalQualifications: input.professionalQualifications as Prisma.InputJsonValue,
    specializations: input.specializations,
    experienceYearsBefore: input.experienceYearsBefore,
    teacherRegistrationNo: input.teacherRegistrationNo,
  };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
      await lockTeachingEmployee(tx, input.employeeId);
      const current = await tx.teacherProfile.findUnique({ where: { employeeId: input.employeeId }, select: TEACHER_PROFILE_SELECT });
      if (!current) {
        if (input.version !== null) throw new ConflictError("This teacher profile was changed by someone else. Reload the page and try again.");
        await tx.teacherProfile.create({ data: { employeeId: input.employeeId, ...data } });
        await audit(tx, actorOf(ctx), { action: "teacher_profile.create", entityType: "TeacherProfile", entityId: input.employeeId, after: { fields: Object.keys(data), version: 1 } });
        return;
      }
      if (input.version !== current.version) throw new ConflictError("This teacher profile was changed by someone else. Reload the page and try again.");
      const changed = (Object.keys(data) as (keyof typeof data)[]).filter((k) => JSON.stringify(current[k] ?? null) !== JSON.stringify(data[k] ?? null));
      if (changed.length === 0) return;
      const r = await tx.teacherProfile.updateMany({ where: { employeeId: input.employeeId, version: current.version }, data: { ...data, version: { increment: 1 } } });
      if (r.count !== 1) throw new ConflictError("This teacher profile was changed by someone else. Reload the page and try again.");
      await audit(tx, actorOf(ctx), {
        action: "teacher_profile.update",
        entityType: "TeacherProfile",
        entityId: input.employeeId,
        before: { version: current.version },
        after: { fields: changed, version: current.version + 1 },
      });
    });
  } catch (e) {
    if (isTransactionBusy(e)) throw new ServiceBusyError();
    throw e;
  }
}
