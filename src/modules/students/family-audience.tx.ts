import type { prisma, Tx } from "@/lib/db";

/**
 * Phase 6C-M1 (notices, P22 read receipts): how many family accounts a notice reaches — activated, active guardian
 * portal accounts with at least one child ACTIVELY enrolled in the audience (whole session, some classes, or some
 * sections) whose link isn't blocked (portalAccess, P24). A count only: no names, no contact data. No authorization
 * here — the notices service authorized the caller for this notice.
 */
type Db = Tx | typeof prisma;

export interface FamilyAudience {
  academicSessionId: string;
  classIds?: readonly string[];
  sectionIds?: readonly string[];
}

/** The user filter behind the count (also used to count only in-audience family reads — review 6C-M1 L1). */
export function familyAccountWhere(a: FamilyAudience) {
  const enrollment = {
    academicSessionId: a.academicSessionId,
    status: "ACTIVE" as const,
    ...(a.sectionIds ? { sectionId: { in: [...a.sectionIds] } } : {}),
    ...(a.classIds ? { section: { classId: { in: [...a.classIds] } } } : {}),
  };
  return {
    isActive: true,
    deletedAt: null,
    privacyConsentAt: { not: null },
    guardian: { deletedAt: null, students: { some: { portalAccess: true, student: { deletedAt: null, enrollments: { some: enrollment } } } } },
  };
}

/** Phase 6C-M2: the ids of those accounts (notice fan-out), at most `limit`. */
export async function familyAccountIds(db: Db, a: FamilyAudience, limit: number): Promise<string[]> {
  return (await db.user.findMany({ where: familyAccountWhere(a), select: { id: true }, orderBy: { id: "asc" }, take: limit })).map((u) => u.id);
}

export async function countFamilyAccounts(db: Db, a: FamilyAudience): Promise<number> {
  return db.user.count({ where: familyAccountWhere(a) });
}
