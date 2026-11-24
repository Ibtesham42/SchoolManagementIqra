import { lockPayroll } from "@/modules/payroll/payroll.tx";
import { openSessionAttendanceDatesTx } from "@/modules/students/students.tx";
import { prisma, type Tx } from "@/lib/db";
import {
  isWeeklyOff,
  readWeeklyOff,
  weeklyOffSchema,
  type WeeklyOff,
} from "@/modules/hr/leave.rules";
import { lockLeaveCalendar } from "@/modules/hr/leave.tx";
import { audit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { authorize, authorizeAny, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import {
  discardUpload,
  prepareUpload,
  recordUpload,
  retireStoredFile,
} from "@/modules/files/files.service";
import { invalidateSchoolProfileCache } from "./settings.public";
import type {
  AcademicSessionInput,
  PortalPaymentSettingsInput,
  SchoolProfileInput,
} from "./settings.schemas";
import { portalSettingsSchema, readPortalSettings } from "./settings.schemas";
import {
  assertCanBeCurrent,
  assertEditable,
  assertNoOverlap,
  assertSessionShape,
  assertStatusTransition,
  feeFormatProblem,
  parseDateOnly,
  type SessionLike,
  type SessionStatus,
} from "./settings.rules";

const SETTINGS_ID = "default";
const actorOf = (ctx: AuthContext) => ({
  userId: ctx.userId,
  label: ctx.username,
  ipHash: ctx.ipHash,
  requestId: ctx.requestId,
});

const PROFILE_SELECT = {
  name: true,
  shortCode: true,
  affiliationNo: true,
  board: true,
  email: true,
  website: true,
  phones: true,
  address: true,
  timezone: true,
  locale: true,
  currency: true,
  dateFormat: true,
  timings: true,
  logoFileId: true,
  currentAcademicSessionId: true,
  defaultSectionCapacity: true,
  updatedAt: true,
} satisfies Prisma.SchoolSettingSelect;

// ───────────────────────────── School profile ─────────────────────────────

export async function getSchoolSettings(ctx: AuthContext) {
  authorize(ctx, "settings.read");
  return prisma.schoolSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: PROFILE_SELECT,
  });
}

export async function updateSchoolProfile(
  ctx: AuthContext,
  input: SchoolProfileInput,
) {
  authorize(ctx, "settings.manage");
  const data = {
    name: input.name,
    shortCode: input.shortCode,
    affiliationNo: input.affiliationNo,
    board: input.board,
    email: input.email,
    website: input.website,
    phones: input.phones,
    address: input.address as Prisma.InputJsonValue,
    timezone: input.timezone,
    locale: input.locale,
    currency: input.currency,
    dateFormat: input.dateFormat,
    timings: input.timings as Prisma.InputJsonValue,
  };
  await prisma.$transaction(async (tx) => {
    const before = await tx.schoolSetting.findUnique({
      where: { id: SETTINGS_ID },
      select: PROFILE_SELECT,
    });
    await tx.schoolSetting.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, ...data },
      update: data,
    });
    await audit(tx, actorOf(ctx), {
      action: "settings.profile_update",
      entityType: "SchoolSetting",
      entityId: SETTINGS_ID,
      before,
      after: data,
    });
  });
  invalidateSchoolProfileCache();
}

/** Replaces the school logo (PNG/JPEG). The previous logo file is retired, not destroyed. */
export async function setSchoolLogo(
  ctx: AuthContext,
  bytes: Uint8Array,
  fileName: string,
) {
  authorize(ctx, "settings.manage");
  const prepared = await prepareUpload(ctx, "school.logo", bytes, fileName, {
    type: "SchoolSetting",
    id: SETTINGS_ID,
  });
  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.schoolSetting.findUnique({
        where: { id: SETTINGS_ID },
        select: { logoFileId: true },
      });
      if (!current)
        throw new ConflictError(
          "Save the school profile before uploading a logo.",
        );
      const file = await recordUpload(tx, ctx, prepared);
      await tx.schoolSetting.update({
        where: { id: SETTINGS_ID },
        data: { logoFileId: file.id },
      });
      if (current.logoFileId)
        await retireStoredFile(tx, ctx, current.logoFileId);
      await audit(tx, actorOf(ctx), {
        action: "settings.logo_update",
        entityType: "SchoolSetting",
        entityId: SETTINGS_ID,
        before: { logoFileId: current.logoFileId },
        after: { logoFileId: file.id },
      });
    });
  } catch (e) {
    await discardUpload(prepared); // keep storage and database consistent
    throw e;
  }
  invalidateSchoolProfileCache();
}

export async function removeSchoolLogo(ctx: AuthContext) {
  authorize(ctx, "settings.manage");
  await prisma.$transaction(async (tx) => {
    const current = await tx.schoolSetting.findUnique({
      where: { id: SETTINGS_ID },
      select: { logoFileId: true },
    });
    if (!current?.logoFileId) return;
    await tx.schoolSetting.update({
      where: { id: SETTINGS_ID },
      data: { logoFileId: null },
    });
    await retireStoredFile(tx, ctx, current.logoFileId);
    await audit(tx, actorOf(ctx), {
      action: "settings.logo_remove",
      entityType: "SchoolSetting",
      entityId: SETTINGS_ID,
      before: { logoFileId: current.logoFileId },
    });
  });
  invalidateSchoolProfileCache();
}

/**
 * School-wide capacity offered for new sections (owner decision D3: 40). A default, not a limit:
 * existing sections keep their own capacity.
 */
export async function updateDefaultSectionCapacity(
  ctx: AuthContext,
  defaultSectionCapacity: number,
) {
  authorize(ctx, "settings.manage");
  await prisma.$transaction(async (tx) => {
    const current = await tx.schoolSetting.findUnique({
      where: { id: SETTINGS_ID },
      select: { defaultSectionCapacity: true },
    });
    if (!current)
      throw new ConflictError(
        "Save the school profile before changing the default section capacity.",
      );
    if (current.defaultSectionCapacity === defaultSectionCapacity) return;
    await tx.schoolSetting.update({
      where: { id: SETTINGS_ID },
      data: { defaultSectionCapacity },
    });
    await audit(tx, actorOf(ctx), {
      action: "settings.default_capacity_update",
      entityType: "SchoolSetting",
      entityId: SETTINGS_ID,
      before: { defaultSectionCapacity: current.defaultSectionCapacity },
      after: { defaultSectionCapacity },
    });
  });
}

/**
 * Settings that admissions needs, read INSIDE the caller's transaction (no authorization here — the
 * calling admissions service has authorized its own operation). Never returns contact or address data.
 */
export async function readAdmissionSettings(tx: Tx) {
  const row = await tx.schoolSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: {
      shortCode: true,
      idFormats: true,
      requiredAdmissionDocuments: true,
      timezone: true,
    },
  });
  if (!row)
    throw new ConflictError(
      "Save the school profile before admitting students.",
    );
  const formats =
    row.idFormats &&
    typeof row.idFormats === "object" &&
    !Array.isArray(row.idFormats)
      ? (row.idFormats as Record<string, unknown>)
      : {};
  const str = (k: string) =>
    typeof formats[k] === "string" ? (formats[k] as string) : null;
  return {
    shortCode: row.shortCode,
    timezone: row.timezone,
    requiredAdmissionDocuments: row.requiredAdmissionDocuments,
    formats: {
      applicationNo: str("applicationNo"),
      admissionNo: str("admissionNo"),
      studentId: str("studentId"),
    },
  };
}

/**
 * Settings that staff registration needs (Phase 3A, H3), read INSIDE the caller's transaction (no
 * authorization here — the calling HR service has authorized its own operation). No contact or address data.
 */
export async function readEmployeeSettings(tx: Tx) {
  const row = await tx.schoolSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: { shortCode: true, idFormats: true, timezone: true },
  });
  if (!row)
    throw new ConflictError(
      "Save the school profile before registering employees.",
    );
  const formats =
    row.idFormats &&
    typeof row.idFormats === "object" &&
    !Array.isArray(row.idFormats)
      ? (row.idFormats as Record<string, unknown>)
      : {};
  return {
    shortCode: row.shortCode,
    timezone: row.timezone,
    employeeCodeFormat:
      typeof formats.employeeCode === "string" ? formats.employeeCode : null,
  };
}

// ───────────────────────────── Staff weekly off (Phase 3B, L3) ─────────────────────────────

/** Current staff weekly off (none until the school sets it). Readable by every signed-in user with settings.read. */
export async function getStaffWeeklyOff(ctx: AuthContext): Promise<WeeklyOff> {
  authorize(ctx, "settings.read");
  const row = await prisma.schoolSetting.findUnique({
    where: { id: SETTINGS_ID },
    select: { weeklyOff: true },
  });
  return readWeeklyOff(row?.weeklyOff ?? null);
}

/**
 * L3: the staff weekly off (e.g. Sunday, 2nd and 4th Saturday). Validated by the shared schema; audited. Changing it
 * affects how many working days FUTURE leave requests count; existing requests keep their computed days.
 */
export async function updateStaffWeeklyOff(ctx: AuthContext, value: WeeklyOff) {
  authorize(ctx, "settings.manage");
  const next = weeklyOffSchema.parse(value);
  const normalized = {
    days: [...next.days].sort(),
    saturdays: [...next.saturdays].sort(),
  };
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
    // KI-071 / audit M3-M1: the weekly off decides working days — serialized with leave apply/approve/cancel.
    await lockLeaveCalendar(tx);
    // Row lock: two admins saving at once are serialized, so the audit "before" is never stale.
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM school_setting WHERE id = ${SETTINGS_ID} FOR UPDATE`;
    const current = locked.length
      ? await tx.schoolSetting.findUnique({
          where: { id: SETTINGS_ID },
          select: { weeklyOff: true },
        })
      : null;
    if (!current)
      throw new ConflictError(
        "Save the school profile before setting the weekly off.",
      );
    const before = readWeeklyOff(current.weeklyOff);
    if (JSON.stringify(before) === JSON.stringify(normalized)) return;
    await tx.schoolSetting.update({
      where: { id: SETTINGS_ID },
      data: { weeklyOff: normalized },
    });
    await audit(tx, actorOf(ctx), {
      action: "settings.weekly_off_update",
      entityType: "SchoolSetting",
      entityId: SETTINGS_ID,
      before: { weeklyOff: before },
      after: { weeklyOff: normalized },
    });
  });
}

/** Phase 4A (AC6): the STUDENT weekly off — same shape as the staff one, often different. Not set = none. */
export async function getStudentWeeklyOff(ctx: AuthContext): Promise<WeeklyOff> {
  authorize(ctx, "settings.read");
  const row = await prisma.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { studentWeeklyOff: true } });
  return readWeeklyOff(row?.studentWeeklyOff ?? null);
}

/** For the student-attendance service, inside its transaction (no authorization here). */
export async function readStudentCalendarTx(tx: Tx) {
  const row = await tx.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { studentWeeklyOff: true, timezone: true } });
  return { weeklyOff: readWeeklyOff(row?.studentWeeklyOff ?? null), timezone: row?.timezone ?? null };
}

/** Same rules as the staff weekly off; serialized with attendance marking and holiday writes (shared calendar lock). */
export async function updateStudentWeeklyOff(ctx: AuthContext, value: WeeklyOff) {
  authorize(ctx, "settings.manage");
  const next = weeklyOffSchema.parse(value);
  const normalized = { days: [...next.days].sort(), saturdays: [...next.saturdays].sort() };
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
    await lockLeaveCalendar(tx);
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_setting WHERE id = ${SETTINGS_ID} FOR UPDATE`;
    const current = locked.length ? await tx.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { studentWeeklyOff: true } }) : null;
    if (!current) throw new ConflictError("Save the school profile before setting the weekly off.");
    const before = readWeeklyOff(current.studentWeeklyOff);
    if (JSON.stringify(before) === JSON.stringify(normalized)) return;
    // Review 4A L1: a day that becomes a weekly off must not already have student attendance in an open session —
    // otherwise past percentages would change silently.
    const clash = (await openSessionAttendanceDatesTx(tx)).find((d) => isWeeklyOff(d, normalized) && !isWeeklyOff(d, before));
    if (clash) throw new ConflictError(`Student attendance is already recorded on ${clash}, which would become a weekly off. Choose different days or correct that attendance first.`);
    await tx.schoolSetting.update({ where: { id: SETTINGS_ID }, data: { studentWeeklyOff: normalized } });
    await audit(tx, actorOf(ctx), {
      action: "settings.student_weekly_off_update",
      entityType: "SchoolSetting",
      entityId: SETTINGS_ID,
      before: { studentWeeklyOff: before },
      after: { studentWeeklyOff: normalized },
    });
  });
}

/** Phase 4B (AC14): whether report cards show a rank in class. Off by default. */
export async function getShowRank(ctx: AuthContext): Promise<boolean> {
  authorize(ctx, "settings.read");
  const row = await prisma.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { showRank: true } });
  return row?.showRank ?? false;
}

/** For the results service, inside its publication transaction (no authorization here). */
export async function readResultSettingsTx(tx: Tx) {
  const row = await tx.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { showRank: true, timezone: true } });
  return { showRank: row?.showRank ?? false, timezone: row?.timezone ?? null };
}

/** Changes only FUTURE publications: published report cards keep the rank (or none) in their snapshot. */
export async function updateShowRank(ctx: AuthContext, value: boolean) {
  authorize(ctx, "settings.manage");
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_setting WHERE id = ${SETTINGS_ID} FOR UPDATE`;
    if (locked.length === 0) throw new ConflictError("Save the school profile before changing result settings.");
    const cur = await tx.schoolSetting.findUniqueOrThrow({ where: { id: SETTINGS_ID }, select: { showRank: true } });
    if (cur.showRank === value) return;
    await tx.schoolSetting.update({ where: { id: SETTINGS_ID }, data: { showRank: value } });
    await audit(tx, actorOf(ctx), { action: "settings.show_rank_update", entityType: "SchoolSetting", entityId: SETTINGS_ID, before: { showRank: cur.showRank }, after: { showRank: value } });
  });
}

const formatsOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Phase 5 (FC12): fee number formats — no default; issue and collection refuse until both are set. */
export async function getFeeNumberFormats(ctx: AuthContext) {
  authorizeAny(ctx, ["settings.read", "fee.structure.manage", "fee.collect"]);
  const row = await prisma.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { idFormats: true, shortCode: true } });
  const f = formatsOf(row?.idFormats);
  return { feeReceipt: typeof f.feeReceipt === "string" ? f.feeReceipt : null, feeInvoice: typeof f.feeInvoice === "string" ? f.feeInvoice : null, shortCode: row?.shortCode ?? null };
}

/** For the fee services, inside their transaction (no authorization here). */
export async function readFeeSettingsTx(tx: Tx) {
  const row = await tx.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { idFormats: true, shortCode: true, timezone: true } });
  const f = formatsOf(row?.idFormats);
  return {
    feeReceipt: typeof f.feeReceipt === "string" ? f.feeReceipt : null,
    feeInvoice: typeof f.feeInvoice === "string" ? f.feeInvoice : null,
    shortCode: row?.shortCode ?? null,
    timezone: row?.timezone ?? null,
  };
}

/**
 * Set both fee number formats (FC12). `settings.manage` or the fee setup manager (the Accountant sets fees up) — but
 * once any invoice or receipt exists, `settings.manage` only (KI-104). Changing a format only affects numbers issued
 * afterwards; issued numbers never change (unique columns).
 */
export async function updateFeeNumberFormats(ctx: AuthContext, input: { feeReceipt: string; feeInvoice: string }) {
  authorizeAny(ctx, ["settings.manage", "fee.structure.manage"]);
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_setting WHERE id = ${SETTINGS_ID} FOR UPDATE`;
    if (locked.length === 0) throw new ConflictError("Save the school profile before setting fee number formats.");
    const cur = await tx.schoolSetting.findUniqueOrThrow({ where: { id: SETTINGS_ID }, select: { idFormats: true, shortCode: true } });
    // KI-104 (owner 2026-11-20): once any invoice or receipt number exists, only settings.manage may change the formats
    // (a cashier must not restart the visible numbering mid-year).
    const [invoices, receipts] = await Promise.all([tx.feeInvoice.count({ take: 1 }), tx.feePayment.count({ take: 1 })]);
    if (invoices + receipts > 0 && !hasPermission(ctx, "settings.manage")) {
      throw new ForbiddenError("Invoices or receipts already have numbers, so only the school administrator can change these formats.");
    }
    const sessions = await tx.academicSession.findMany({ select: { name: true }, take: 200 });
    const longestSession = sessions.reduce((a, s) => (s.name.length > a.length ? s.name : a), "2026-27");
    const issues = (["feeReceipt", "feeInvoice"] as const).flatMap((k) => {
      const problem = feeFormatProblem(k, input[k], { code: cur.shortCode, longestSession });
      return problem ? [{ path: k, message: problem }] : [];
    });
    if (issues.length) throw new ValidationError(issues[0].message, issues);
    const before = formatsOf(cur.idFormats);
    if (before.feeReceipt === input.feeReceipt && before.feeInvoice === input.feeInvoice) return;
    await tx.schoolSetting.update({ where: { id: SETTINGS_ID }, data: { idFormats: { ...before, feeReceipt: input.feeReceipt, feeInvoice: input.feeInvoice } } });
    await audit(tx, actorOf(ctx), {
      action: "settings.fee_number_formats_update",
      entityType: "SchoolSetting",
      entityId: SETTINGS_ID,
      before: { feeReceipt: before.feeReceipt ?? null, feeInvoice: before.feeInvoice ?? null },
      after: { feeReceipt: input.feeReceipt, feeInvoice: input.feeInvoice },
    });
  });
}

/** Phase 3C (P3): how slips are prorated — WORKING_DAYS or CALENDAR_DAYS. No default: payroll refuses until it is set. */
export async function getPayrollDayBasis(ctx: AuthContext): Promise<"WORKING_DAYS" | "CALENDAR_DAYS" | null> {
  authorize(ctx, "settings.read");
  const row = await prisma.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { payrollDayBasis: true } });
  return row?.payrollDayBasis ?? null;
}

/** For payroll, inside its transaction (no authorization here). */
export async function readPayrollSettingsTx(tx: Tx) {
  const row = await tx.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { payrollDayBasis: true, timezone: true } });
  return { dayBasis: row?.payrollDayBasis ?? null, timezone: row?.timezone ?? null };
}

/**
 * Changing the basis changes how FUTURE runs prorate; prepared slips keep the basis they were computed with (snapshot).
 * Serialized with payroll runs (payroll advisory lock) so a run can't be prepared half on each basis.
 */
export async function updatePayrollDayBasis(ctx: AuthContext, value: "WORKING_DAYS" | "CALENDAR_DAYS") {
  authorize(ctx, "settings.manage");
  if (value !== "WORKING_DAYS" && value !== "CALENDAR_DAYS") throw new ConflictError("Choose working days or calendar days.");
  await prisma.$transaction(async (tx) => {
    await lockPayroll(tx); // same helper as the payroll module (review 3C-M4 Info)
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_setting WHERE id = ${SETTINGS_ID} FOR UPDATE`;
    if (locked.length === 0) throw new ConflictError("Save the school profile before setting the payroll basis.");
    const cur = await tx.schoolSetting.findUniqueOrThrow({ where: { id: SETTINGS_ID }, select: { payrollDayBasis: true } });
    if (cur.payrollDayBasis === value) return;
    await tx.schoolSetting.update({ where: { id: SETTINGS_ID }, data: { payrollDayBasis: value } });
    await audit(tx, actorOf(ctx), { action: "settings.payroll_day_basis_update", entityType: "SchoolSetting", entityId: SETTINGS_ID, before: { payrollDayBasis: cur.payrollDayBasis }, after: { payrollDayBasis: value } });
  });
}

/**
 * For the leave services, INSIDE their transaction (no authorization here — the caller authorized its operation):
 * the academic session's dates and status (L1: leave year = session) and the staff weekly off.
 */
export async function readLeaveCalendarTx(tx: Tx, academicSessionId: string) {
  const [session, setting] = await Promise.all([
    tx.academicSession.findUnique({
      where: { id: academicSessionId },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        status: true,
      },
    }),
    tx.schoolSetting.findUnique({
      where: { id: SETTINGS_ID },
      select: { weeklyOff: true, timezone: true },
    }),
  ]);
  if (!session) throw new NotFoundError("Academic session not found.");
  return {
    session,
    weeklyOff: readWeeklyOff(setting?.weeklyOff ?? null),
    timezone: setting?.timezone ?? null,
  };
}

/** The academic session whose dates contain `iso` (sessions never overlap — session guard), or null. */
export async function findSessionForDateTx(tx: Tx, iso: string) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return tx.academicSession.findFirst({
    where: { startDate: { lte: d }, endDate: { gte: d } },
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      status: true,
    },
  });
}

/** Academic sessions (id, name, dates, status) for HR pickers — `employee.read` callers; no other school data. */
export async function listSessionsForStaffPlanning(ctx: AuthContext) {
  authorize(ctx, "employee.read");
  const [sessions, setting] = await Promise.all([
    prisma.academicSession.findMany({
      orderBy: { startDate: "desc" },
      take: 50,
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        status: true,
      },
    }),
    prisma.schoolSetting.findUnique({
      where: { id: SETTINGS_ID },
      select: { currentAcademicSessionId: true },
    }),
  ]);
  return { sessions, currentId: setting?.currentAcademicSessionId ?? null };
}

// ───────────────────────────── Academic sessions ─────────────────────────────

/** Serializes session writes so overlap/current checks can't race (transaction-scoped; pooler-safe). */
async function lockSessionGuard(tx: Tx) {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('school_erp.academic_session_guard'))) AS l`;
}

async function allSessions(tx: Tx): Promise<SessionLike[]> {
  return tx.academicSession.findMany({
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      status: true,
    },
  }) as Promise<SessionLike[]>;
}

async function currentSessionId(tx: Tx): Promise<string | null> {
  return (
    (
      await tx.schoolSetting.findUnique({
        where: { id: SETTINGS_ID },
        select: { currentAcademicSessionId: true },
      })
    )?.currentAcademicSessionId ?? null
  );
}

export async function listAcademicSessions(ctx: AuthContext) {
  authorize(ctx, "settings.read");
  const [sessions, setting] = await prisma.$transaction([
    prisma.academicSession.findMany({
      orderBy: { startDate: "desc" },
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        status: true,
      },
    }),
    prisma.schoolSetting.findUnique({
      where: { id: SETTINGS_ID },
      select: { currentAcademicSessionId: true },
    }),
  ]);
  return { sessions, currentId: setting?.currentAcademicSessionId ?? null };
}

export async function createAcademicSession(
  ctx: AuthContext,
  input: AcademicSessionInput,
) {
  authorize(ctx, "session.manage");
  const startDate = parseDateOnly(input.startDate);
  const endDate = parseDateOnly(input.endDate);
  assertSessionShape(input.name, startDate, endDate);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSessionGuard(tx);
      assertNoOverlap({ startDate, endDate }, await allSessions(tx));
      const created = await tx.academicSession.create({
        data: { name: input.name, startDate, endDate },
        select: { id: true, name: true },
      });
      await audit(tx, actorOf(ctx), {
        action: "session.create",
        entityType: "AcademicSession",
        entityId: created.id,
        after: input,
      });
      return created;
    });
  } catch (e) {
    if (isUniqueViolation(e, "name"))
      throw new ConflictError(
        `A session named "${input.name}" already exists.`,
      );
    throw e;
  }
}

export async function updateAcademicSession(
  ctx: AuthContext,
  id: string,
  input: AcademicSessionInput,
) {
  authorize(ctx, "session.manage");
  const startDate = parseDateOnly(input.startDate);
  const endDate = parseDateOnly(input.endDate);
  assertSessionShape(input.name, startDate, endDate);
  try {
    await prisma.$transaction(async (tx) => {
      await lockSessionGuard(tx);
      const sessions = await allSessions(tx);
      const session = sessions.find((s) => s.id === id);
      if (!session) throw new NotFoundError("Session not found.");
      assertEditable(session);
      assertNoOverlap({ id, startDate, endDate }, sessions);
      await tx.academicSession.update({
        where: { id },
        data: { name: input.name, startDate, endDate },
      });
      await audit(tx, actorOf(ctx), {
        action: "session.update",
        entityType: "AcademicSession",
        entityId: id,
        before: session,
        after: input,
      });
    });
  } catch (e) {
    if (isUniqueViolation(e, "name"))
      throw new ConflictError(
        `A session named "${input.name}" already exists.`,
      );
    throw e;
  }
}

export async function changeAcademicSessionStatus(
  ctx: AuthContext,
  id: string,
  to: SessionStatus,
) {
  authorize(ctx, "session.manage");
  await prisma.$transaction(async (tx) => {
    await lockSessionGuard(tx);
    const session = (await allSessions(tx)).find((s) => s.id === id);
    if (!session) throw new NotFoundError("Session not found.");
    assertStatusTransition(session, to, await currentSessionId(tx));
    await tx.academicSession.update({ where: { id }, data: { status: to } });
    await audit(tx, actorOf(ctx), {
      action: "session.status_change",
      entityType: "AcademicSession",
      entityId: id,
      before: { status: session.status },
      after: { status: to },
    });
  });
}

export async function setCurrentAcademicSession(ctx: AuthContext, id: string) {
  authorize(ctx, "session.manage");
  await prisma.$transaction(async (tx) => {
    await lockSessionGuard(tx);
    const session = (await allSessions(tx)).find((s) => s.id === id);
    if (!session) throw new NotFoundError("Session not found.");
    assertCanBeCurrent(session);
    const before = await currentSessionId(tx);
    const exists = await tx.schoolSetting.findUnique({
      where: { id: SETTINGS_ID },
      select: { id: true },
    });
    if (!exists)
      throw new ConflictError(
        "Save the school profile before choosing the current session.",
      );
    await tx.schoolSetting.update({
      where: { id: SETTINGS_ID },
      data: { currentAcademicSessionId: id },
    });
    await audit(tx, actorOf(ctx), {
      action: "session.set_current",
      entityType: "SchoolSetting",
      entityId: SETTINGS_ID,
      before: { currentAcademicSessionId: before },
      after: { currentAcademicSessionId: id },
    });
  });
  invalidateSchoolProfileCache();
}

// ───────────────────────────── Phase 6C-M3: portal payments and leaver window ─────────────────────────────

/** The portal block as the office sees it (settings.read). */
export async function getPortalSettingsForOffice(ctx: AuthContext) {
  authorize(ctx, "settings.read");
  const row = await prisma.schoolSetting.findUnique({ where: { id: SETTINGS_ID }, select: { features: true } });
  return readPortalSettings(row?.features);
}

/** Saves the UPI details (both or neither) and the leaver window inside `features.portal`; other keys are kept. */
export async function updatePortalPaymentSettings(ctx: AuthContext, input: PortalPaymentSettingsInput) {
  authorize(ctx, "settings.manage");
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_setting WHERE id = ${SETTINGS_ID} FOR UPDATE`;
    if (locked.length === 0) throw new ConflictError("Save the school profile before changing portal settings.");
    const row = await tx.schoolSetting.findUniqueOrThrow({ where: { id: SETTINGS_ID }, select: { features: true } });
    const features = row.features && typeof row.features === "object" && !Array.isArray(row.features) ? (row.features as Record<string, unknown>) : {};
    const before = readPortalSettings(features);
    const upi = input.payeeName === "" ? null : { payeeName: input.payeeName, vpa: input.vpa };
    const next = portalSettingsSchema.parse({ ...before, upi, leaverAccessDays: input.leaverAccessDays });
    await tx.schoolSetting.update({ where: { id: SETTINGS_ID }, data: { features: { ...features, portal: next } as Prisma.InputJsonValue } });
    await audit(tx, actorOf(ctx), {
      action: "settings.portal_update",
      entityType: "SchoolSetting",
      entityId: SETTINGS_ID,
      before: { upi: before.upi, leaverAccessDays: before.leaverAccessDays },
      after: { upi: next.upi, leaverAccessDays: next.leaverAccessDays },
    });
  });
  invalidateSchoolProfileCache();
}
