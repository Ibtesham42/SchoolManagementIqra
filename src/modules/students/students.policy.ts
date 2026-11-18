import { ForbiddenError } from "@/lib/errors";
import type { Scope } from "@/lib/rbac/catalog";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Record scope for student records (pure — unit tested; design §4.2).
 *  - ALL: every student who is not soft-deleted.
 *  - ASSIGNED (class teacher, until TeacherAllocation in Phase 4): students with an ACTIVE enrollment in
 *    a section where the user is the class teacher, in a session that is NOT CLOSED (S-02: closing a session
 *    ends its class-teacher access, even though enrollments there stay ACTIVE until promotion in Phase 4).
 *    Nothing else — no applications, no other sections.
 *  - CHILDREN / SELF (parent and student portal roles): no user ↔ student link exists yet, so these are
 *    refused rather than guessed. The portal phase adds them here explicitly.
 */
export type StudentScope = "ALL" | "ASSIGNED";

export function studentScopeOf(scope: Scope): StudentScope {
  if (scope === "ALL" || scope === "ASSIGNED") return scope;
  throw new ForbiddenError();
}

/** Prisma filter for the students a scope may see (always excludes soft-deleted rows). */
export function studentScopeWhere(scope: StudentScope, userId: string): Prisma.StudentWhereInput {
  if (scope === "ALL") return { deletedAt: null };
  return { deletedAt: null, enrollments: { some: { status: "ACTIVE", section: { classTeacherId: userId, academicSession: { status: { not: "CLOSED" } } } } } };
}
