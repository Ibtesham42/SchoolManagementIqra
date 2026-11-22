import type { prisma, Tx } from "@/lib/db";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";

/**
 * Primary-guardian name and phone for other modules (Phase 5C fee defaulters, PHASE_5_PLAN.md FC20: the school needs
 * to call). Contact data is personal: callers check `canReadGuardianContacts` (whole-school `student.read`) to show them
 * and `canExportGuardianContacts` to put them in a file. Name and phone only — never address, email, Aadhaar or occupation.
 */
type Db = Tx | typeof prisma;

export function canReadGuardianContacts(ctx: AuthContext): boolean {
  return hasPermission(ctx, "student.read") && scopeFor(ctx, "student.read") === "ALL";
}

/**
 * Review 5C-M1 M1: contacts in a DOWNLOAD (CSV) follow the student-export rule (D8, students.service exportStudents):
 * also `admission.read` at ALL, so an Accountant, who holds `export.run` for finance, can't take a phone list away.
 */
export function canExportGuardianContacts(ctx: AuthContext): boolean {
  return canReadGuardianContacts(ctx) && hasPermission(ctx, "admission.read") && scopeFor(ctx, "admission.read") === "ALL";
}

export async function primaryGuardianContacts(db: Db, studentIds: readonly string[]): Promise<Map<string, { name: string; phone: string }>> {
  const out = new Map<string, { name: string; phone: string }>();
  for (let i = 0; i < studentIds.length; i += 1000) {
    const rows = await db.studentGuardian.findMany({
      where: { studentId: { in: studentIds.slice(i, i + 1000) }, isPrimary: true, guardian: { deletedAt: null } },
      select: { studentId: true, guardian: { select: { name: true, phone: true } } },
    });
    for (const r of rows) out.set(r.studentId, { name: r.guardian.name, phone: r.guardian.phone });
  }
  return out;
}
