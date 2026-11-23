import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { todayInTimeZone } from "@/lib/format";
import { NotFoundError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { PORTAL_NOT_FOUND, assertPortalStudent, portalScopeOf, portalVisibleChildren } from "@/lib/rbac/portal-access";
import { portalCanSee, type PortalWindow } from "@/lib/rbac/portal-scope";
import { getPortalSettings, getSchoolTimezone } from "@/modules/settings/settings.public";

/**
 * Phase 6A-M2 — family-facing student reads (PHASE_6_PLAN.md §2.1, ADR-044). Separate from the staff functions in
 * students.service, so a staff list can never be widened to a portal scope by accident (and vice versa).
 *
 * Every function: authorize → assertPortalStudent (membership + child + leaver window) → explicit whitelist
 * `select`. Never documents, contacts of other guardians, address, medical, Aadhaar or internal remarks.
 */

export async function portalWindow(now = new Date()): Promise<PortalWindow> {
  const [timeZone, settings] = await Promise.all([getSchoolTimezone(), getPortalSettings(now.getTime())]);
  return { today: todayInTimeZone(timeZone, now), leaverAccessDays: settings.leaverAccessDays };
}

/** Latest enrollment first (sessions by start date): the class shown is the most recent one. */
const LATEST_ENROLLMENT = {
  orderBy: [{ academicSession: { startDate: "desc" } }, { createdAt: "desc" }],
  take: 1,
  select: {
    status: true,
    academicSession: { select: { name: true } },
    section: { select: { code: true, class: { select: { name: true } } } },
    rollNumber: { select: { rollNumber: true } },
  },
} satisfies Prisma.StudentEnrollmentFindManyArgs;

export interface PortalChildSummary {
  id: string;
  fullName: string;
  studentCode: string;
  className: string | null;
  sectionCode: string | null;
  /** false for a leaver inside the window: only report cards and receipts remain (P17). */
  current: boolean;
}

/** The child switcher / home list: the children this account can still see, by name. Bounded by the session (≤ 20). */
export async function listPortalChildren(ctx: AuthContext, window?: PortalWindow): Promise<PortalChildSummary[]> {
  authorize(ctx, "student.read");
  // Review 6A-M2 L2: without the portal scope for student.read (a misconfigured role) the shell shows "no linked
  // children" instead of failing every portal page.
  if (!portalScopeOf(ctx)("student.read")) return [];
  const w = window ?? (await portalWindow());
  const visible = portalVisibleChildren(ctx, w);
  if (visible.length === 0) return [];
  const rows = await prisma.student.findMany({
    where: { id: { in: visible.map((c) => c.studentId) }, deletedAt: null },
    orderBy: [{ fullNameNormalized: "asc" }, { id: "asc" }],
    select: { id: true, fullName: true, studentCode: true, enrollments: LATEST_ENROLLMENT },
  });
  const scopeOf = portalScopeOf(ctx);
  return rows.map((r) => {
    const e = r.enrollments[0];
    return {
      id: r.id,
      fullName: r.fullName,
      studentCode: r.studentCode,
      className: e?.section.class.name ?? null,
      sectionCode: e?.section.code ?? null,
      current: !!ctx.portal && portalCanSee(ctx.portal, scopeOf, r.id, "profile", w),
    };
  });
}

const RELATION_LABEL: Record<string, string> = { FATHER: "Father", MOTHER: "Mother", GUARDIAN: "Guardian", OTHER: "Other" };

/** One child's profile for the portal (read only). NotFound for anything this account may not see. */
export async function getPortalStudentProfile(ctx: AuthContext, studentId: string, window?: PortalWindow) {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, studentId, "profile", w);
  const s = await prisma.student.findFirst({
    where: { id: studentId, deletedAt: null },
    select: {
      id: true,
      fullName: true,
      studentCode: true,
      admissionNo: true,
      dob: true,
      gender: true,
      admissionDate: true,
      enrollments: LATEST_ENROLLMENT,
      // Only the viewing guardian's own link (relation) — never the other guardians or their contacts.
      // (A student account has no guardianId: the filter then matches nothing.)
      guardians: { where: { guardianId: ctx.portal?.guardianId ?? "" }, take: 1, select: { relation: true } },
    },
  });
  if (!s) throw new NotFoundError(PORTAL_NOT_FOUND);
  const e = s.enrollments[0];
  const relation = s.guardians[0]?.relation;
  return {
    id: s.id,
    fullName: s.fullName,
    studentCode: s.studentCode,
    admissionNo: s.admissionNo,
    dob: s.dob.toISOString().slice(0, 10),
    gender: s.gender as string,
    admissionDate: s.admissionDate.toISOString().slice(0, 10),
    sessionName: e?.academicSession.name ?? null,
    className: e?.section.class.name ?? null,
    sectionCode: e?.section.code ?? null,
    rollNumber: e?.rollNumber?.rollNumber ?? null,
    yourRelation: relation ? RELATION_LABEL[relation] ?? null : null,
  };
}
export type PortalStudentProfile = Awaited<ReturnType<typeof getPortalStudentProfile>>;
