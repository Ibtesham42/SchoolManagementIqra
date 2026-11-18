import { prisma } from "@/lib/db";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { classTeachersOfCurrentSession } from "@/modules/academic/sections.service";
import { employeeReadAccess } from "./hr.policy";
import { EMPLOYMENT_STATUSES, STAFF_TYPES, type EmploymentStatus, type StaffType } from "./hr.rules";

/**
 * HR dashboard (Phase 3A M5, PHASE_3_PLAN.md §7). Every block is gated by the permission behind its data:
 *  - counts by staff type × status and by department — directory readers (`employee.read` ALL; aggregates only);
 *  - recent joiners / leavers — personal tier (joining and leaving dates are employment terms, H6);
 *  - current staff without a login — also `user.read` (account information);
 *  - active teaching staff without a class-teacher section in the current session — also `user.read` and
 *    `academic.read` ALL.
 * Lists are short and show directory fields only.
 */
const LIST = 10;
const PERSON = { id: true, employeeCode: true, fullName: true, designation: { select: { name: true } } } as const;
type Person = { id: string; employeeCode: string; fullName: string; designation: { name: string } };

export async function hrDashboard(ctx: AuthContext) {
  const { tier } = employeeReadAccess(ctx);
  const current = { deletedAt: null, employmentStatus: { in: ["ACTIVE", "ON_LEAVE"] as EmploymentStatus[] } };

  const [byTypeStatus, byDepartment, departments] = await Promise.all([
    prisma.employee.groupBy({ by: ["staffType", "employmentStatus"], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.employee.groupBy({ by: ["departmentId"], where: current, _count: { _all: true } }),
    prisma.department.findMany({ select: { id: true, name: true }, take: 500 }),
  ]);
  const counts = Object.fromEntries(STAFF_TYPES.map((t) => [t, Object.fromEntries(EMPLOYMENT_STATUSES.map((s) => [s, 0]))])) as Record<StaffType, Record<EmploymentStatus, number>>;
  for (const g of byTypeStatus) counts[g.staffType][g.employmentStatus] = g._count._all;
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const perDepartment = byDepartment
    .map((g) => ({ id: g.departmentId, name: deptName.get(g.departmentId) ?? "—", count: g._count._all }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "en-IN"));

  let joiners: (Person & { joiningDate: Date })[] | null = null;
  let leavers: (Person & { leavingDate: Date | null; employmentStatus: EmploymentStatus })[] | null = null;
  if (tier === "personal") {
    [joiners, leavers] = await Promise.all([
      prisma.employee.findMany({ where: { deletedAt: null }, orderBy: [{ joiningDate: "desc" }, { id: "asc" }], take: 5, select: { ...PERSON, joiningDate: true } }),
      prisma.employee.findMany({ where: { deletedAt: null, leavingDate: { not: null } }, orderBy: [{ leavingDate: "desc" }, { id: "asc" }], take: 5, select: { ...PERSON, leavingDate: true, employmentStatus: true } }),
    ]);
  }

  let withoutLogin: { total: number; rows: Person[] } | null = null;
  let teachersWithoutSection: { sessionName: string | null; total: number; rows: Person[] } | null = null;
  if (hasPermission(ctx, "user.read")) {
    // Relation filters in the database (no in-memory id lists, no silent caps — review M5 L2). A linked but
    // deactivated account still counts as "has a login" (the card says "linked account").
    const where = { ...current, user: { is: null } };
    const [total, rows] = await Promise.all([prisma.employee.count({ where }), prisma.employee.findMany({ where, orderBy: [{ fullNameNormalized: "asc" }, { id: "asc" }], take: LIST, select: PERSON })]);
    withoutLogin = { total, rows };

    if (hasPermission(ctx, "academic.read") && scopeFor(ctx, "academic.read") === "ALL") {
      const ct = await classTeachersOfCurrentSession(ctx);
      if (ct) {
        const twhere = { deletedAt: null, employmentStatus: "ACTIVE" as const, staffType: "TEACHING" as const, NOT: { user: { is: { id: { in: ct.userIds } } } } };
        const [ttotal, trows] = await Promise.all([
          prisma.employee.count({ where: twhere }),
          prisma.employee.findMany({ where: twhere, orderBy: [{ fullNameNormalized: "asc" }, { id: "asc" }], take: LIST, select: PERSON }),
        ]);
        teachersWithoutSection = { sessionName: ct.sessionName, total: ttotal, rows: trows };
      } else {
        teachersWithoutSection = { sessionName: null, total: 0, rows: [] };
      }
    }
  }
  return { tier, counts, perDepartment, joiners, leavers, withoutLogin, teachersWithoutSection };
}
