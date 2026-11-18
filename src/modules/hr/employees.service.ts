import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { nextSequence } from "@/lib/sequence";
import { Prisma } from "@/generated/prisma/client";
import { readEmployeeSettings } from "@/modules/settings/settings.service";
import { fullNameOf, normalizeName, normalizePhone } from "@/modules/students/person-fields";
import { canReadPersonal, employeeReadAccess, employeeRecordAccess, type EmployeeTier } from "./hr.policy";
import {
  assertEmployeeDates,
  changedFields,
  EMPLOYMENT_STATUSES,
  planEmployeeCode,
  redactForAudit,
  renderEmployeeCode,
  REPORTABLE_STATUSES,
  type EmploymentStatus,
  type StaffType,
} from "./hr.rules";
import type { CreateEmployeeInput, ListEmployeesInput, UpdateEmployeeContactInput, UpdateEmployeePersonalInput } from "./hr.schemas";

/**
 * Staff records, Phase 3A M2 (PHASE_3_PLAN.md §6, ADR-036): registration, directory, profile, field-level
 * edits of personal and contact details. Employment changes, status changes (leaving/rejoining), reporting
 * changes, teacher profiles, account links and documents arrive in M3/M4.
 *
 * Every function: authorize → tier/scope policy → explicit `select` → (writes) one short transaction with row
 * locks, lock_timeout 5 s (D11) and audit in the same transaction. Audit rows carry ids, codes, enum values
 * and field names — never names, contact details, dates of birth or addresses ("[REDACTED]"). The permanent
 * employee code is written only by registration (H3).
 *
 * Lock order: master data FOR SHARE (department, designation) → reports-to employee FOR SHARE → sequence
 * counter row (nextSequence). Edits lock only the edited employee row; nothing locks in the reverse order.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const parseDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const json = (v: unknown) => (v === null ? undefined : (v as Prisma.InputJsonValue));
/** Prisma JSON columns: null → SQL NULL explicitly on update. */
const jsonOrDbNull = (v: unknown) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}
function mapBusy(e: unknown): never {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}
const stale = () => new ConflictError("This employee record was changed by someone else. Reload the page and try again.");
const fieldError = (path: string, message: string) => new ValidationError("Please correct the highlighted fields.", [{ path, message }]);

// ───────────────────────────── Registration ─────────────────────────────

/**
 * H3/H9/H10/H12: one transaction — master data FOR SHARE (must be active; the staff type comes from the
 * designation), reports-to FOR SHARE (must still work here), dates against the school's today, the permanent
 * employee code from lib/sequence (rolls back with the transaction — no gaps from failures), the employee row,
 * the JOINED service event and the audit entry.
 */
export async function registerEmployee(ctx: AuthContext, input: CreateEmployeeInput): Promise<{ id: string; employeeCode: string }> {
  // Registration enters personal-tier data and looks up the reporting manager: the same gate as edits, plus
  // directory access, so a manage-only custom role can't use reportsToId as an existence oracle (review L2).
  authorizeEdit(ctx);
  employeeReadAccess(ctx);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const settings = await readEmployeeSettings(tx);
      assertEmployeeDates({ dob: input.dob, joiningDate: input.joiningDate, confirmationDate: input.confirmationDate }, todayInTimeZone(settings.timezone ?? undefined));

      const [dept] = await tx.$queryRaw<{ is_active: boolean }[]>`SELECT is_active FROM department WHERE id = ${input.departmentId} FOR SHARE`;
      if (!dept?.is_active) throw fieldError("departmentId", "Choose an active department.");
      const [desig] = await tx.$queryRaw<{ is_active: boolean; staff_type: StaffType }[]>`SELECT is_active, staff_type::text AS staff_type FROM designation WHERE id = ${input.designationId} FOR SHARE`;
      if (!desig?.is_active) throw fieldError("designationId", "Choose an active designation.");
      if (input.reportsToId) {
        const [boss] = await tx.$queryRaw<{ employment_status: EmploymentStatus }[]>`SELECT employment_status::text AS employment_status FROM employee WHERE id = ${input.reportsToId} AND deleted_at IS NULL FOR SHARE`;
        if (!boss || !REPORTABLE_STATUSES.includes(boss.employment_status)) throw fieldError("reportsToId", "Choose a current employee as the reporting manager.");
      }

      const joiningDate = parseDate(input.joiningDate);
      const plan = planEmployeeCode({ configuredFormat: settings.employeeCodeFormat, joiningDate, schoolCode: settings.shortCode });
      const employeeCode = renderEmployeeCode(plan, await nextSequence(tx, plan.key));
      const fullName = fullNameOf(input.firstName, input.middleName, input.lastName);
      const created = await tx.employee.create({
        data: {
          employeeCode,
          staffType: desig.staff_type,
          appointmentType: input.appointmentType,
          firstName: input.firstName,
          middleName: input.middleName,
          lastName: input.lastName,
          fullName,
          fullNameNormalized: normalizeName(fullName),
          dob: parseDate(input.dob),
          gender: input.gender,
          personalPhone: input.personalPhone,
          workPhone: input.workPhone,
          personalEmail: input.personalEmail,
          workEmail: input.workEmail,
          address: json(input.address),
          emergencyContact: json(input.emergencyContact),
          departmentId: input.departmentId,
          designationId: input.designationId,
          reportsToId: input.reportsToId,
          joiningDate,
          confirmationDate: input.confirmationDate ? parseDate(input.confirmationDate) : null,
          createdById: ctx.userId,
        },
        select: { id: true },
      });
      const employment = { staffType: desig.staff_type, appointmentType: input.appointmentType, departmentId: input.departmentId, designationId: input.designationId, reportsToId: input.reportsToId };
      await tx.employeeServiceEvent.create({
        data: { employeeId: created.id, eventType: "JOINED", effectiveDate: joiningDate, after: employment, actedById: ctx.userId },
      });
      await audit(tx, actorOf(ctx), {
        action: "employee.create",
        entityType: "Employee",
        entityId: created.id,
        after: redactForAudit({ employeeCode, ...employment, joiningDate: input.joiningDate, confirmationDate: input.confirmationDate, employmentStatus: "ACTIVE" }),
      });
      return { id: created.id, employeeCode };
    });
  } catch (e) {
    // Backstop: a counter key that renders the same code as another (e.g. a changed format) — never a duplicate.
    if (isUniqueViolation(e, "employeeCode")) throw new ConflictError("The employee ID could not be assigned. Ask a Super Admin to check the employee ID format in Settings.");
    mapBusy(e);
  }
}

// ───────────────────────────── Directory ─────────────────────────────

const DIRECTORY_SELECT = {
  id: true,
  employeeCode: true,
  fullName: true,
  staffType: true,
  employmentStatus: true,
  workPhone: true,
  workEmail: true,
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeSelect;

/**
 * Directory filters. Appointment type and personal phone are personal-tier data: for directory-only readers they
 * are neither filterable nor searchable — a filter would list who is on contract/probation (security review M1).
 * Exported for unit tests.
 */
export function directoryWhere(input: ListEmployeesInput, tier: EmployeeTier): Prisma.EmployeeWhereInput {
  const and: Prisma.EmployeeWhereInput[] = [{ deletedAt: null }];
  if (input.staffType) and.push({ staffType: input.staffType });
  if (input.departmentId) and.push({ departmentId: input.departmentId });
  if (input.designationId) and.push({ designationId: input.designationId });
  if (input.status) and.push({ employmentStatus: input.status });
  if (input.appointmentType && tier === "personal") and.push({ appointmentType: input.appointmentType });
  const q = input.q?.trim();
  if (q) {
    const or: Prisma.EmployeeWhereInput[] = [{ fullNameNormalized: { contains: normalizeName(q) } }, { employeeCode: { startsWith: q.toUpperCase() } }];
    const phone = normalizePhone(q);
    if (phone) {
      or.push({ workPhone: phone });
      // Personal numbers are personal-tier data: matching on them would reveal them to directory-only readers.
      if (tier === "personal") or.push({ personalPhone: phone });
    }
    and.push({ OR: or });
  }
  return { AND: and };
}

export async function listEmployees(ctx: AuthContext, input: ListEmployeesInput) {
  const { tier } = employeeReadAccess(ctx);
  const where = directoryWhere(input, tier);
  const [total, rows] = await prisma.$transaction([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      orderBy: [{ fullNameNormalized: "asc" }, { id: "asc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: DIRECTORY_SELECT,
    }),
  ]);
  return { total, page: input.page, pageSize: input.pageSize, rows };
}

export async function countEmployeesByStatus(ctx: AuthContext): Promise<Record<EmploymentStatus, number>> {
  employeeReadAccess(ctx);
  const groups = await prisma.employee.groupBy({ by: ["employmentStatus"], where: { deletedAt: null }, _count: { _all: true } });
  const out = Object.fromEntries(EMPLOYMENT_STATUSES.map((s) => [s, 0])) as Record<EmploymentStatus, number>;
  for (const g of groups) out[g.employmentStatus] = g._count._all;
  return out;
}

/** Current employees for the "reports to" picker (directory fields only). */
export async function listReportingCandidates(ctx: AuthContext) {
  authorize(ctx, "employee.manage");
  employeeReadAccess(ctx);
  return prisma.employee.findMany({
    where: { deletedAt: null, employmentStatus: { in: [...REPORTABLE_STATUSES] } },
    orderBy: [{ fullNameNormalized: "asc" }, { id: "asc" }],
    take: 1000,
    select: { id: true, employeeCode: true, fullName: true, designation: { select: { name: true } } },
  });
}

// ───────────────────────────── Profile ─────────────────────────────

const PROFILE_DIRECTORY_SELECT = {
  ...DIRECTORY_SELECT,
  version: true,
  reportsTo: { select: { id: true, employeeCode: true, fullName: true } },
} satisfies Prisma.EmployeeSelect;

const PROFILE_PERSONAL_SELECT = {
  ...PROFILE_DIRECTORY_SELECT,
  firstName: true,
  middleName: true,
  lastName: true,
  dob: true,
  gender: true,
  personalPhone: true,
  personalEmail: true,
  address: true,
  emergencyContact: true,
  appointmentType: true,
  joiningDate: true,
  confirmationDate: true,
  leavingDate: true,
  leavingReason: true,
} satisfies Prisma.EmployeeSelect;

export type EmployeeProfile =
  | ({ tier: "directory" } & Prisma.EmployeeGetPayload<{ select: typeof PROFILE_DIRECTORY_SELECT }>)
  | ({ tier: "personal" } & Prisma.EmployeeGetPayload<{ select: typeof PROFILE_PERSONAL_SELECT }>);

/** Missing, soft-deleted and out-of-scope all look the same (NotFound — no oracle). */
export async function getEmployee(ctx: AuthContext, id: string): Promise<EmployeeProfile> {
  const { tier } = employeeRecordAccess(ctx, id);
  if (tier === "personal") {
    const row = await prisma.employee.findFirst({ where: { id, deletedAt: null }, select: PROFILE_PERSONAL_SELECT });
    if (!row) throw new NotFoundError("Employee not found.");
    return { tier, ...row };
  }
  const row = await prisma.employee.findFirst({ where: { id, deletedAt: null }, select: PROFILE_DIRECTORY_SELECT });
  if (!row) throw new NotFoundError("Employee not found.");
  return { tier, ...row };
}

/** School time zone for date inputs ("today" bounds); the services re-check inside their transactions. */
export async function employeeTimeZone(ctx: AuthContext): Promise<string | undefined> {
  authorize(ctx, "employee.manage");
  return (await readEmployeeSettings(prisma)).timezone ?? undefined;
}

// ───────────────────────────── Field-level edits ─────────────────────────────

/**
 * Editing personal or contact details shows and changes personal-tier data, so it needs
 * `employee.personal.read` as well as `employee.manage` (every default holder of manage has both).
 */
function authorizeEdit(ctx: AuthContext) {
  authorize(ctx, "employee.manage");
  if (!canReadPersonal(ctx)) throw new ForbiddenError("You need permission to view employees' personal details to edit them.");
}

async function lockEmployee(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM employee WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Employee not found.");
  return tx.employee.findUniqueOrThrow({
    where: { id },
    select: {
      version: true,
      firstName: true,
      middleName: true,
      lastName: true,
      dob: true,
      gender: true,
      joiningDate: true,
      personalPhone: true,
      workPhone: true,
      personalEmail: true,
      workEmail: true,
      address: true,
      emergencyContact: true,
    },
  });
}

async function applyEdit(ctx: AuthContext, id: string, version: number, build: (current: Awaited<ReturnType<typeof lockEmployee>>, tx: Tx) => Promise<{ before: Record<string, unknown>; next: Record<string, unknown>; data: Prisma.EmployeeUpdateManyMutationInput }>, action: string) {
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockEmployee(tx, id);
      if (current.version !== version) throw stale();
      const { before, next, data } = await build(current, tx);
      const diff = changedFields(before, next);
      if (Object.keys(diff.after).length === 0) return;
      const r = await tx.employee.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), {
        action,
        entityType: "Employee",
        entityId: id,
        before: { ...redactForAudit(diff.before), version },
        after: { ...redactForAudit(diff.after), version: version + 1 },
      });
    });
  } catch (e) {
    mapBusy(e);
  }
}

export async function updateEmployeePersonal(ctx: AuthContext, input: UpdateEmployeePersonalInput) {
  authorizeEdit(ctx);
  await applyEdit(
    ctx,
    input.id,
    input.version,
    async (current, tx) => {
      const settings = await readEmployeeSettings(tx);
      assertEmployeeDates({ dob: input.dob, joiningDate: isoDate(current.joiningDate) }, todayInTimeZone(settings.timezone ?? undefined));
      const fullName = fullNameOf(input.firstName, input.middleName, input.lastName);
      return {
        before: { firstName: current.firstName, middleName: current.middleName, lastName: current.lastName, dob: isoDate(current.dob), gender: current.gender },
        next: { firstName: input.firstName, middleName: input.middleName, lastName: input.lastName, dob: input.dob, gender: input.gender },
        data: {
          firstName: input.firstName,
          middleName: input.middleName,
          lastName: input.lastName,
          fullName,
          fullNameNormalized: normalizeName(fullName),
          dob: parseDate(input.dob),
          gender: input.gender,
        },
      };
    },
    "employee.update_personal",
  );
}

export async function updateEmployeeContact(ctx: AuthContext, input: UpdateEmployeeContactInput) {
  authorizeEdit(ctx);
  await applyEdit(
    ctx,
    input.id,
    input.version,
    async (current) => ({
      before: {
        personalPhone: current.personalPhone,
        workPhone: current.workPhone,
        personalEmail: current.personalEmail,
        workEmail: current.workEmail,
        address: current.address,
        emergencyContact: current.emergencyContact,
      },
      next: {
        personalPhone: input.personalPhone,
        workPhone: input.workPhone,
        personalEmail: input.personalEmail,
        workEmail: input.workEmail,
        address: input.address,
        emergencyContact: input.emergencyContact,
      },
      data: {
        personalPhone: input.personalPhone,
        workPhone: input.workPhone,
        personalEmail: input.personalEmail,
        workEmail: input.workEmail,
        address: jsonOrDbNull(input.address),
        emergencyContact: jsonOrDbNull(input.emergencyContact),
      },
    }),
    "employee.update_contact",
  );
}
