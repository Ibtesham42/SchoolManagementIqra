import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { authorize, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { releaseClassTeacherAssignments } from "@/modules/academic/academic.tx";
import { lockSuperAdminGuard } from "@/modules/identity/super-admin-guard";
import { deactivateUserTx, linkedAccountTx } from "@/modules/identity/users.service";
import { readEmployeeSettings } from "@/modules/settings/settings.service";
import { canReadPersonal, employeeReadAccess, employeeRecordAccess, isOwnRecord } from "./hr.policy";
import {
  assertEffectiveDate,
  createsReportingCycle,
  planStatusChange,
  redactForAudit,
  REPORTABLE_STATUSES,
  type EmploymentStatus,
  type ServiceEventType,
} from "./hr.rules";
import type { ChangeEmploymentInput, ChangeReportingInput, ChangeStatusInput } from "./hr.schemas";

/**
 * Employment lifecycle, Phase 3A M4a (PHASE_3_PLAN.md §3a H10–H13): employment changes, reporting line,
 * status (leaving, long-term leave, rejoining) and the append-only service history (H12 — written only here and
 * at registration, in the same transaction as the change; no update/delete path).
 *
 * Every write needs `employee.manage` + the personal tier (employment terms are personal data, H6) + directory
 * access, and is refused for the caller's own record (approver ≠ subject; Super Admin exempt).
 *
 * Lock order (documented; no reverse order anywhere):
 *   [lockSuperAdminGuard — first statement, only when a leaving also deactivates the account (rule 17)]
 *   → reporting-graph advisory lock (reporting changes only) → employee FOR UPDATE → master data / manager
 *   FOR SHARE → linked user FOR UPDATE (identity) → class-teacher sections FOR UPDATE (academic).
 *   Class-teacher assignment and account linking also take the employee row first, so they can't deadlock with this.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const parseDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const stale = () => new ConflictError("This employee record was changed by someone else. Reload the page and try again.");
const fieldError = (path: string, message: string) => new ValidationError("Please correct the highlighted fields.", [{ path, message }]);

function authorizeLifecycle(ctx: AuthContext, employeeId: string, opts: { ownAllowed?: boolean } = {}) {
  authorize(ctx, "employee.manage");
  employeeReadAccess(ctx);
  if (!canReadPersonal(ctx)) throw new ForbiddenError("You need permission to view employees' personal details to change employment records.");
  if (!opts.ownAllowed && isOwnRecord(ctx, employeeId) && !ctx.isSuperAdmin) throw new ForbiddenError("You can't change your own employment record. Ask another administrator.");
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

const LOCK_SELECT = {
  version: true,
  staffType: true,
  employmentStatus: true,
  departmentId: true,
  designationId: true,
  appointmentType: true,
  reportsToId: true,
  joiningDate: true,
  confirmationDate: true,
  leavingDate: true,
} satisfies Prisma.EmployeeSelect;

async function lockEmployee(tx: Tx, id: string, version: number) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM employee WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Employee not found.");
  const row = await tx.employee.findUniqueOrThrow({ where: { id }, select: LOCK_SELECT });
  if (row.version !== version) throw stale();
  return row;
}

async function schoolToday(tx: Tx) {
  return todayInTimeZone((await readEmployeeSettings(tx)).timezone ?? undefined);
}

function mapBusy(e: unknown): never {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}

interface EventRow {
  eventType: ServiceEventType;
  effectiveDate: Date;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  remarks?: string | null;
}

async function writeEvents(tx: Tx, ctx: AuthContext, employeeId: string, events: EventRow[]) {
  if (events.length === 0) return;
  await tx.employeeServiceEvent.createMany({
    data: events.map((e) => ({
      employeeId,
      eventType: e.eventType,
      effectiveDate: e.effectiveDate,
      before: e.before as Prisma.InputJsonValue | undefined,
      after: e.after as Prisma.InputJsonValue | undefined,
      remarks: e.remarks ?? null,
      actedById: ctx.userId,
    })),
  });
}

// ───────────────────────────── Employment changes ─────────────────────────────

/**
 * Department, designation (same staff type — H9), appointment type and confirmation date. One service event per
 * changed item; a confirmation date, once recorded, can be corrected but not removed.
 */
export async function changeEmployment(ctx: AuthContext, input: ChangeEmploymentInput): Promise<{ events: number }> {
  authorizeLifecycle(ctx, input.id);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const row = await lockEmployee(tx, input.id, input.version);
      const today = await schoolToday(tx);
      assertEffectiveDate("employment", { effectiveDate: input.effectiveDate, joiningDate: isoDate(row.joiningDate) }, today);
      const effectiveDate = parseDate(input.effectiveDate);
      const events: EventRow[] = [];

      if (input.departmentId !== row.departmentId) {
        const [d] = await tx.$queryRaw<{ is_active: boolean }[]>`SELECT is_active FROM department WHERE id = ${input.departmentId} FOR SHARE`;
        if (!d?.is_active) throw fieldError("departmentId", "Choose an active department.");
        events.push({ eventType: "DEPARTMENT_CHANGED", effectiveDate, before: { departmentId: row.departmentId }, after: { departmentId: input.departmentId }, remarks: input.remarks });
      }
      if (input.designationId !== row.designationId) {
        const [g] = await tx.$queryRaw<{ is_active: boolean; staff_type: string }[]>`SELECT is_active, staff_type::text AS staff_type FROM designation WHERE id = ${input.designationId} FOR SHARE`;
        if (!g?.is_active) throw fieldError("designationId", "Choose an active designation.");
        if (g.staff_type !== row.staffType) throw fieldError("designationId", "Choose a designation of the same staff type (teaching or non-teaching).");
        events.push({ eventType: "DESIGNATION_CHANGED", effectiveDate, before: { designationId: row.designationId }, after: { designationId: input.designationId }, remarks: input.remarks });
      }
      if (input.appointmentType !== row.appointmentType) {
        events.push({ eventType: "APPOINTMENT_TYPE_CHANGED", effectiveDate, before: { appointmentType: row.appointmentType }, after: { appointmentType: input.appointmentType }, remarks: input.remarks });
      }
      const currentConfirmation = row.confirmationDate ? isoDate(row.confirmationDate) : null;
      if (input.confirmationDate !== currentConfirmation) {
        if (!input.confirmationDate) throw fieldError("confirmationDate", "A recorded confirmation date can be corrected but not removed.");
        if (input.confirmationDate < isoDate(row.joiningDate)) throw fieldError("confirmationDate", "The confirmation date can't be before the joining date.");
        if (input.confirmationDate > today) throw fieldError("confirmationDate", "The confirmation date can't be in the future.");
        events.push({ eventType: "CONFIRMED", effectiveDate: parseDate(input.confirmationDate), before: { confirmationDate: currentConfirmation }, after: { confirmationDate: input.confirmationDate }, remarks: input.remarks });
      }
      if (events.length === 0) return { events: 0 };

      const r = await tx.employee.updateMany({
        where: { id: input.id, version: input.version },
        data: {
          departmentId: input.departmentId,
          designationId: input.designationId,
          appointmentType: input.appointmentType,
          confirmationDate: input.confirmationDate ? parseDate(input.confirmationDate) : row.confirmationDate,
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw stale();
      await writeEvents(tx, ctx, input.id, events);
      await audit(tx, actorOf(ctx), {
        action: "employee.change_employment",
        entityType: "Employee",
        entityId: input.id,
        before: { ...redactForAudit(Object.assign({}, ...events.map((e) => e.before))), version: row.version },
        after: { ...redactForAudit(Object.assign({}, ...events.map((e) => e.after))), events: events.map((e) => e.eventType), version: row.version + 1 },
      });
      return { events: events.length };
    });
  } catch (e) {
    mapBusy(e);
  }
}

// ───────────────────────────── Reporting line (H10) ─────────────────────────────

/** All reporting changes are serialized by one transaction-scoped advisory lock, so the cycle check is exact. */
async function lockReportingGraph(tx: Tx) {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('school_erp.reporting_graph'))) AS l`;
}

export async function changeReporting(ctx: AuthContext, input: ChangeReportingInput): Promise<{ changed: boolean }> {
  authorizeLifecycle(ctx, input.id);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      await lockReportingGraph(tx);
      const row = await lockEmployee(tx, input.id, input.version);
      assertEffectiveDate("employment", { effectiveDate: input.effectiveDate, joiningDate: isoDate(row.joiningDate) }, await schoolToday(tx));
      if (input.reportsToId === row.reportsToId) return { changed: false };
      if (input.reportsToId) {
        if (input.reportsToId === input.id) throw fieldError("reportsToId", "An employee can't report to themselves.");
        const [m] = await tx.$queryRaw<{ employment_status: EmploymentStatus }[]>`SELECT employment_status::text AS employment_status FROM employee WHERE id = ${input.reportsToId} AND deleted_at IS NULL FOR SHARE`;
        if (!m || !REPORTABLE_STATUSES.includes(m.employment_status)) throw fieldError("reportsToId", "Choose a current employee as the reporting manager.");
        // Whole graph including soft-deleted rows (review M4a L3): a chain through a deleted record still counts.
        const graph = await tx.$queryRaw<{ id: string; reports_to_id: string }[]>`SELECT id, reports_to_id FROM employee WHERE reports_to_id IS NOT NULL`;
        if (createsReportingCycle(input.id, input.reportsToId, new Map(graph.map((g) => [g.id, g.reports_to_id])))) {
          throw fieldError("reportsToId", "That would create a reporting loop: the chosen manager reports (directly or indirectly) to this employee.");
        }
      }
      const r = await tx.employee.updateMany({ where: { id: input.id, version: input.version }, data: { reportsToId: input.reportsToId, version: { increment: 1 } } });
      if (r.count !== 1) throw stale();
      await writeEvents(tx, ctx, input.id, [{ eventType: "REPORTING_CHANGED", effectiveDate: parseDate(input.effectiveDate), before: { reportsToId: row.reportsToId }, after: { reportsToId: input.reportsToId }, remarks: input.remarks }]);
      await audit(tx, actorOf(ctx), {
        action: "employee.change_reporting",
        entityType: "Employee",
        entityId: input.id,
        before: { reportsToId: row.reportsToId, version: row.version },
        after: { reportsToId: input.reportsToId, version: row.version + 1 },
      });
      return { changed: true };
    });
  } catch (e) {
    mapBusy(e);
  }
}

// ───────────────────────────── Status (H11, H13) ─────────────────────────────

export interface StatusChangeResult {
  status: EmploymentStatus;
  sectionsReleased: number;
  accountDeactivated: boolean;
  /** Leaving recorded but the linked login is still active (operator chose not to, or may not, deactivate it). */
  accountStillActive: boolean;
}

export async function changeStatus(ctx: AuthContext, input: ChangeStatusInput): Promise<StatusChangeResult> {
  authorizeLifecycle(ctx, input.id);
  if (input.deactivateAccount && !hasPermission(ctx, "user.manage")) {
    throw new ForbiddenError("Deactivating the login account needs permission to manage users. Record the leaving, then ask an administrator.");
  }
  try {
    return await prisma.$transaction(async (tx) => {
      // Rule 17: deactivation can change Super Admin membership — the guard must be the first statement.
      if (input.deactivateAccount) await lockSuperAdminGuard(tx);
      await lockTimeout(tx);
      const row = await lockEmployee(tx, input.id, input.version);
      const plan = planStatusChange(row.employmentStatus, input.action);
      const today = await schoolToday(tx);
      const leavingIso = row.leavingDate ? isoDate(row.leavingDate) : null;
      assertEffectiveDate(plan.rejoining ? "rejoin" : "status", { effectiveDate: input.effectiveDate, joiningDate: isoDate(row.joiningDate), leavingDate: leavingIso }, today);
      // Review M4a L4: a status change can't be dated before the latest recorded status event (e.g. a rejoining).
      const [latest] = await tx.$queryRaw<{ d: string | null }[]>`
        SELECT to_char(max(effective_date), 'YYYY-MM-DD') AS d FROM employee_service_event
        WHERE employee_id = ${input.id} AND event_type IN ('JOINED', 'STATUS_CHANGED', 'RESIGNED', 'TERMINATED', 'RETIRED', 'REJOINED')`;
      if (latest?.d && input.effectiveDate < latest.d) throw fieldError("effectiveDate", "The date can't be before the last recorded status change.");
      if (input.deactivateAccount && !plan.leaving) throw fieldError("deactivateAccount", "The login account can only be deactivated when the employee leaves.");

      const effectiveDate = parseDate(input.effectiveDate);
      const r = await tx.employee.updateMany({
        where: { id: input.id, version: input.version },
        data: {
          employmentStatus: plan.next,
          ...(plan.leaving ? { leavingDate: effectiveDate, leavingReason: input.reason } : {}),
          ...(plan.rejoining ? { leavingDate: null, leavingReason: null } : {}),
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw stale();
      await writeEvents(tx, ctx, input.id, [
        {
          eventType: plan.event,
          effectiveDate,
          before: { employmentStatus: row.employmentStatus, ...(plan.rejoining ? { leavingDate: leavingIso } : {}) },
          after: { employmentStatus: plan.next },
          remarks: input.reason,
        },
      ]);

      let sectionsReleased = 0;
      let accountDeactivated = false;
      let accountStillActive = false;
      if (plan.leaving) {
        const account = await linkedAccountTx(tx, input.id);
        if (account) {
          // Lock order: employee (held) → user (identity) → sections (academic).
          if (input.deactivateAccount) accountDeactivated = await deactivateUserTx(tx, ctx, account.id, "employee_left");
          sectionsReleased = await releaseClassTeacherAssignments(tx, actorOf(ctx), account.id, "employee_left");
          accountStillActive = account.isActive && !accountDeactivated;
        }
      }
      await audit(tx, actorOf(ctx), {
        action: "employee.status_change",
        entityType: "Employee",
        entityId: input.id,
        before: { employmentStatus: row.employmentStatus, version: row.version },
        after: { employmentStatus: plan.next, event: plan.event, ...redactForAudit({ leavingDate: plan.leaving ? input.effectiveDate : null }), sectionsReleased, accountDeactivated, version: row.version + 1 },
      });
      return { status: plan.next, sectionsReleased, accountDeactivated, accountStillActive };
    });
  } catch (e) {
    mapBusy(e);
  }
}

// ───────────────────────────── Service history (read) ─────────────────────────────

/**
 * The append-only history of one employee, newest first. Personal tier as a whole (H6): it carries employment
 * terms (appointment type, joining/confirmation/leaving dates), remarks and who acted — so directory-only readers
 * get no events (`restricted`), while SELF readers see their own history. Referenced departments, designations
 * and managers are resolved to names.
 */
export async function listServiceHistory(ctx: AuthContext, employeeId: string) {
  const { tier } = employeeRecordAccess(ctx, employeeId);
  const empty = { department: {} as Record<string, string>, designation: {} as Record<string, string>, manager: {} as Record<string, string> };
  if (tier !== "personal") return { tier, restricted: true as const, events: [], names: empty };
  const personal = true;
  const events = await prisma.employeeServiceEvent.findMany({
    where: { employeeId, employee: { deletedAt: null } },
    orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: { id: true, eventType: true, effectiveDate: true, before: true, after: true, createdAt: true, ...(personal ? { remarks: true, actedBy: { select: { displayName: true } } } : {}) },
  });
  const ids = (key: string) =>
    [...new Set(events.flatMap((e) => [e.before, e.after]).map((j) => (j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>)[key] : null)).filter((v): v is string => typeof v === "string"))];
  const [departments, designations, managers] = await Promise.all([
    prisma.department.findMany({ where: { id: { in: ids("departmentId") } }, select: { id: true, name: true } }),
    prisma.designation.findMany({ where: { id: { in: ids("designationId") } }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { id: { in: ids("reportsToId") } }, select: { id: true, fullName: true, employeeCode: true } }),
  ]);
  return {
    tier,
    restricted: false as const,
    events,
    names: {
      department: Object.fromEntries(departments.map((d) => [d.id, d.name])),
      designation: Object.fromEntries(designations.map((d) => [d.id, d.name])),
      manager: Object.fromEntries(managers.map((e) => [e.id, `${e.fullName} (${e.employeeCode})`])),
    },
  };
}
