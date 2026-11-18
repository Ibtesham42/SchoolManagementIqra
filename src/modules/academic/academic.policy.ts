import { ForbiddenError } from "@/lib/errors";
import type { AuthContext } from "@/lib/rbac/authorize";
import type { Scope } from "@/lib/rbac/catalog";

/**
 * Record scope for `academic.read` (pure — unit tested). The service calls `authorize(ctx,
 * "academic.read")` first and passes the returned scope here.
 *
 *  - ALL      → every class and section.
 *  - ASSIGNED → sections the user is class teacher of, in sessions that are NOT CLOSED (S-02: an assignment
 *               ends with its session), and their classes. Phase 4 widens this to
 *               TeacherAllocation (subjects taught); until then class-teacher sections are the only
 *               assignment that exists.
 *  - anything else (SELF / CHILDREN) → no academic structure access.
 *
 * Returned objects are plain Prisma `where` fragments (structural types — no client import).
 */
/** A class-teacher assignment only counts while its session is open (PLANNED or ACTIVE) — S-02. */
export const OPEN_SESSION = { status: { not: "CLOSED" as const } };

export interface SectionScopeWhere {
  classTeacherId?: string;
  academicSession?: typeof OPEN_SESSION;
}
export interface ClassScopeWhere {
  sections?: { some: { classTeacherId: string; academicSession: typeof OPEN_SESSION } };
}

export function sectionScopeWhere(ctx: AuthContext, scope: Scope): SectionScopeWhere {
  if (scope === "ALL") return {};
  if (scope === "ASSIGNED") return { classTeacherId: ctx.userId, academicSession: OPEN_SESSION };
  throw new ForbiddenError();
}

export function classScopeWhere(ctx: AuthContext, scope: Scope): ClassScopeWhere {
  if (scope === "ALL") return {};
  if (scope === "ASSIGNED") return { sections: { some: { classTeacherId: ctx.userId, academicSession: OPEN_SESSION } } };
  throw new ForbiddenError();
}

/** Single-record check after loading a section (for detail reads). */
export function canReadSection(ctx: AuthContext, scope: Scope, section: { classTeacherId: string | null; sessionStatus: "PLANNED" | "ACTIVE" | "CLOSED" }): boolean {
  if (scope === "ALL") return true;
  if (scope === "ASSIGNED") return section.classTeacherId === ctx.userId && section.sessionStatus !== "CLOSED";
  return false;
}

/** System roles whose holders may be class teachers (A1: TEACHER or CLASS_TEACHER; custom roles are not eligible). */
export const CLASS_TEACHER_ROLE_KEYS = ["TEACHER", "CLASS_TEACHER"] as const;
