import type { prisma, Tx } from "@/lib/db";

/**
 * Phase 6C-M2 (P23) — who gets a notification about a student: the ACTIVATED, active portal accounts of the student's
 * guardians whose link isn't blocked (P24 — a blocked guardian gets nothing), and, when `students` is set, the student's
 * own activated account (P14). Returns the student's first name for the notification text — nothing else about the
 * student or the guardian. No authorization: the calling service authorized its own (already committed) write.
 */
type Db = Tx | typeof prisma;

export interface FamilyRecipient {
  studentId: string;
  userId: string;
  firstName: string;
}

const CHUNK = 1000;
const LIVE_ACCOUNT = { isActive: true, deletedAt: null, privacyConsentAt: { not: null } } as const;

export async function familyRecipientsOf(db: Db, studentIds: readonly string[], opts: { students: boolean }): Promise<FamilyRecipient[]> {
  const ids = [...new Set(studentIds)];
  const out: FamilyRecipient[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const links = await db.studentGuardian.findMany({
      where: { studentId: { in: slice }, portalAccess: true, student: { deletedAt: null }, guardian: { deletedAt: null, account: { is: LIVE_ACCOUNT } } },
      select: { studentId: true, student: { select: { firstName: true } }, guardian: { select: { account: { select: { id: true } } } } },
    });
    for (const l of links) if (l.guardian.account) out.push({ studentId: l.studentId, userId: l.guardian.account.id, firstName: l.student.firstName });
    if (opts.students) {
      const own = await db.user.findMany({ where: { ...LIVE_ACCOUNT, studentId: { in: slice }, student: { deletedAt: null } }, select: { id: true, studentId: true, student: { select: { firstName: true } } } });
      for (const u of own) if (u.studentId && u.student) out.push({ studentId: u.studentId, userId: u.id, firstName: u.student.firstName });
    }
  }
  return out;
}

/** The portal account of a guardian (any state), for clearing notifications on a custody block. */
export async function guardianAccountIds(db: Db, guardianId: string): Promise<string[]> {
  return (await db.user.findMany({ where: { guardianId }, select: { id: true }, take: 1 })).map((u) => u.id);
}
