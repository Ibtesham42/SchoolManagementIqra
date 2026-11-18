import { prisma, type Tx } from "@/lib/db";
import {
  readWeeklyOff,
  weeklyOffSchema,
  type WeeklyOff,
} from "@/modules/hr/leave.rules";
import { audit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
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
  SchoolProfileInput,
} from "./settings.schemas";
import {
  assertCanBeCurrent,
  assertEditable,
  assertNoOverlap,
  assertSessionShape,
  assertStatusTransition,
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
