import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { stripDocumentImageMetadata } from "@/lib/images/photo";
import { enforce, RULES } from "@/lib/rate-limit";
import { hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { detectFileType } from "@/lib/storage/file-types";
import { endOfLocalDay, localDateTimeToUtc } from "@/lib/zoned-time";
import { assertSessionWritable } from "@/modules/academic/academic.rules";
import { lockSessionShared, noticeClasses, noticeSectionOptions, noticeSections, sessionOptions, activeClassOptions } from "@/modules/academic/academic.tx";
import { discardUpload, prepareUpload, readStoredFile, recordUpload, retireStoredFile, type PreparedUpload } from "@/modules/files/files.service";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { todayInTimeZone } from "@/lib/format";
import { countFamilyAccounts, familyAccountWhere, type FamilyAudience } from "@/modules/students/family-audience.tx";
import { liveWhere, manageScopeOf, mayWriteNotice, noticeState, publishMoment, STAFF_AUDIENCES, type ManageScope } from "./notices.policy";
import type { CreateNoticeInput, NoticeAudience, NoticeRefInput, NoticeScope, UpdateNoticeInput } from "./notices.schemas";

/**
 * Phase 6C-M1 — internal notices (PHASE_6_PLAN.md P21, P22; ADR-047). Staff side: compose, publish, withdraw, read.
 *
 * - Write (`notice.manage`): ALL → any audience / scope; ASSIGNED (Class Teacher) → families of their own sections only
 *   (notices.policy). A notice the caller may not manage is NotFound (no existence oracle).
 * - Life cycle: DRAFT (edit, attach, delete) → PUBLISHED (visible from publishAt — a future time is "scheduled" —
 *   until expiresAt) → WITHDRAWN. Never edited after publish (P22): withdraw and write a new one.
 * - Staff readers (`notice.read`, every staff role): live STAFF / ALL notices (always school-wide, CHECK). Opening one
 *   records a read receipt. Families read through notices.portal.ts.
 * - Read receipts: managers see how many family accounts opened a notice out of how many it reaches (activated family
 *   accounts with an actively enrolled child in the audience), and how many staff opened it. Counts only, no names.
 * Lock order: academic_session FOR SHARE → notice FOR UPDATE → section FOR SHARE (ORDER BY id).
 * Audit rows carry ids, audience, scope, target counts and times — never the title or text.
 * Uncached (like 6B-M1): every read is bounded; the 6B-M4 Neon measurement decides whether a per-audience cache is
 * needed (P20 "measure first").
 */
const ATTACHMENT = "notice.attachment" as const;
const OWNER_TYPE = "Notice";
const NOT_FOUND = "Notice not found.";
const LIST_LIMIT = 100;
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const schoolToday = async () => todayInTimeZone(await getSchoolTimezone());
const requireManage = (ctx: AuthContext): ManageScope => {
  const s = manageScopeOf(ctx);
  if (!s) throw new ForbiddenError();
  return s;
};

export const noticeAccess = (ctx: AuthContext) => ({ read: !ctx.portal && hasPermission(ctx, "notice.read"), manage: manageScopeOf(ctx) });

/** Prisma filter: the notices an ASSIGNED manager still manages (their own, every target section theirs, session open). */
const ownSectionNotices = (userId: string) => ({
  createdById: userId,
  audience: "FAMILIES" as const,
  scope: "SECTION" as const,
  targets: { some: {}, every: { section: { classTeacherId: userId, academicSession: { status: { not: "CLOSED" as const } } } } },
});

// ───────────────────────────── compose options ─────────────────────────────

/** The session new notices belong to (the current one, else the newest that isn't closed) and the audience choices. */
export async function noticeComposeOptions(ctx: AuthContext) {
  const scope = requireManage(ctx);
  const sessions = await sessionOptions(prisma);
  const session = sessions.find((s) => s.isCurrent && s.status !== "CLOSED") ?? sessions.find((s) => s.status !== "CLOSED");
  if (!session) return null;
  const [sections, classes] = await Promise.all([
    noticeSectionOptions(prisma, session.id, scope === "ASSIGNED" ? ctx.userId : undefined),
    scope === "ALL" ? activeClassOptions(prisma) : Promise.resolve([]),
  ]);
  return { scope, session: { id: session.id, name: session.name }, sections, classes, timeZone: await getSchoolTimezone() };
}

// ───────────────────────────── shared checks ─────────────────────────────

async function scheduleOf(publishAt: string, showUntil: string) {
  const tz = await getSchoolTimezone();
  const at = publishAt ? localDateTimeToUtc(publishAt, tz) : null;
  if (publishAt && !at) throw new ValidationError("Use a valid date and time.", [{ path: "publishAt", message: "Use a valid date and time." }]);
  const until = showUntil ? endOfLocalDay(showUntil, tz) : null;
  if (showUntil && !until) throw new ValidationError("Use a valid date.", [{ path: "showUntil", message: "Use a valid date." }]);
  if (until && until <= (at ?? new Date())) throw new ValidationError("“Show until” must be after the notice is published.", [{ path: "showUntil", message: "Choose a later day." }]);
  return { publishAt: at, expiresAt: until };
}

/** Targets exist in the session (sections) / exist and are active (classes), and the caller may write to them. */
async function checkTargets(tx: Tx, ctx: AuthContext, scope: ManageScope, academicSessionId: string, v: { audience: NoticeAudience; scope: NoticeScope; targetIds: string[] }) {
  let sections: Awaited<ReturnType<typeof noticeSections>> = [];
  if (v.scope === "SECTION") {
    sections = await noticeSections(tx, academicSessionId, v.targetIds, true);
    if (sections.length !== v.targetIds.length) throw new ValidationError("A chosen section isn't in this session.", [{ path: "targetIds", message: "Choose sections of this session." }]);
  } else if (v.scope === "CLASS") {
    const classes = await noticeClasses(tx, v.targetIds);
    if (classes.length !== v.targetIds.length || classes.some((c) => !c.isActive)) throw new ValidationError("A chosen class doesn't exist or is inactive.", [{ path: "targetIds", message: "Choose active classes." }]);
  }
  // Authorship: a new notice is the caller's; an edited draft was already checked to be theirs (lockNotice).
  if (!mayWriteNotice(scope, ctx.userId, { audience: v.audience, scope: v.scope, createdById: ctx.userId, sections })) throw new ForbiddenError("You can write notices only to the families of the sections you are class teacher of.");
}

const targetRows = (noticeId: string, academicSessionId: string, scope: NoticeScope, ids: string[]) =>
  ids.map((id) => ({ noticeId, academicSessionId, scope, ...(scope === "CLASS" ? { classId: id } : { sectionId: id }) }));

async function lockNotice(tx: Tx, ctx: AuthContext, scope: ManageScope, id: string, version: number) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  const peek = await tx.notice.findUnique({ where: { id }, select: { academicSessionId: true } });
  if (!peek) throw new NotFoundError(NOT_FOUND);
  const sessionStatus = await lockSessionShared(tx, peek.academicSessionId);
  const [row] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM notice WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new NotFoundError(NOT_FOUND);
  const n = await tx.notice.findUniqueOrThrow({
    where: { id },
    select: { id: true, academicSessionId: true, audience: true, scope: true, status: true, publishAt: true, expiresAt: true, attachmentFileId: true, createdById: true, targets: { select: { sectionId: true, classId: true } } },
  });
  const sectionIds = n.targets.flatMap((t) => (t.sectionId ? [t.sectionId] : []));
  const sections = await noticeSections(tx, n.academicSessionId, sectionIds, true);
  // Out of scope looks exactly like unknown.
  if (!mayWriteNotice(scope, ctx.userId, { audience: n.audience, scope: n.scope, createdById: n.createdById, sections })) throw new NotFoundError(NOT_FOUND);
  if (row.version !== version) throw new ConflictError("This notice was changed by someone else. Reload the page and try again.");
  return { ...n, sessionStatus };
}

const assertDraft = (n: { status: string }) => {
  if (n.status !== "DRAFT") throw new ConflictError("This notice is already published. Withdraw it and write a new one.");
};

// ───────────────────────────── writes ─────────────────────────────

export async function createNotice(ctx: AuthContext, input: CreateNoticeInput) {
  const scope = requireManage(ctx);
  await enforce(RULES.noticeCompose, ctx.userId);
  const when = await scheduleOf(input.publishAt, input.showUntil);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
      assertSessionWritable(await lockSessionShared(tx, input.academicSessionId));
      await checkTargets(tx, ctx, scope, input.academicSessionId, input);
      const n = await tx.notice.create({
        data: { academicSessionId: input.academicSessionId, title: input.title, body: input.body, audience: input.audience, scope: input.scope, publishAt: when.publishAt, expiresAt: when.expiresAt, createdById: ctx.userId },
        select: { id: true },
      });
      if (input.targetIds.length) await tx.noticeTarget.createMany({ data: targetRows(n.id, input.academicSessionId, input.scope, input.targetIds) });
      await audit(tx, actorOf(ctx), { action: "notice.create", entityType: "Notice", entityId: n.id, after: { academicSessionId: input.academicSessionId, audience: input.audience, scope: input.scope, targets: input.targetIds.length } });
      return n;
    });
  } catch (e) {
    return busy(e);
  }
}

export async function updateNotice(ctx: AuthContext, input: UpdateNoticeInput) {
  const scope = requireManage(ctx);
  const when = await scheduleOf(input.publishAt, input.showUntil);
  try {
    await prisma.$transaction(async (tx) => {
      const n = await lockNotice(tx, ctx, scope, input.id, input.version);
      assertDraft(n);
      assertSessionWritable(n.sessionStatus);
      await checkTargets(tx, ctx, scope, n.academicSessionId, input);
      // Targets first: they copy the notice's scope (composite FK), so a scope change can't leave a mismatched row.
      await tx.noticeTarget.deleteMany({ where: { noticeId: n.id } });
      await tx.notice.update({ where: { id: n.id }, data: { title: input.title, body: input.body, audience: input.audience, scope: input.scope, publishAt: when.publishAt, expiresAt: when.expiresAt, version: { increment: 1 } } });
      if (input.targetIds.length) await tx.noticeTarget.createMany({ data: targetRows(n.id, n.academicSessionId, input.scope, input.targetIds) });
      await audit(tx, actorOf(ctx), {
        action: "notice.update",
        entityType: "Notice",
        entityId: n.id,
        before: { audience: n.audience, scope: n.scope, targets: n.targets.length },
        after: { audience: input.audience, scope: input.scope, targets: input.targetIds.length },
      });
    });
  } catch (e) {
    busy(e);
  }
}

/** Drafts only: a hard delete (published notices are withdrawn, never deleted). */
export async function deleteNotice(ctx: AuthContext, input: NoticeRefInput) {
  const scope = requireManage(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      const n = await lockNotice(tx, ctx, scope, input.id, input.version);
      assertDraft(n);
      await tx.notice.delete({ where: { id: n.id } });
      if (n.attachmentFileId) await retireStoredFile(tx, ctx, n.attachmentFileId);
      await audit(tx, actorOf(ctx), { action: "notice.delete", entityType: "Notice", entityId: n.id });
    });
  } catch (e) {
    busy(e);
  }
}

export async function publishNotice(ctx: AuthContext, input: NoticeRefInput) {
  const scope = requireManage(ctx);
  await enforce(RULES.noticeCompose, ctx.userId);
  try {
    return await prisma.$transaction(async (tx) => {
      const n = await lockNotice(tx, ctx, scope, input.id, input.version);
      assertDraft(n);
      assertSessionWritable(n.sessionStatus);
      const now = new Date();
      const m = publishMoment(n.publishAt, n.expiresAt, now);
      if ("error" in m) throw new ValidationError(m.error);
      await tx.notice.update({ where: { id: n.id }, data: { status: "PUBLISHED", publishAt: m.publishAt, publishedAt: now, publishedById: ctx.userId, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "notice.publish", entityType: "Notice", entityId: n.id, after: { publishAt: m.publishAt.toISOString(), expiresAt: n.expiresAt?.toISOString() ?? null } });
      return { scheduled: m.publishAt > now };
    });
  } catch (e) {
    return busy(e);
  }
}

/** Published (live, scheduled or expired) → WITHDRAWN: readers stop seeing it at once. Allowed in a closed session. */
export async function withdrawNotice(ctx: AuthContext, input: NoticeRefInput) {
  const scope = requireManage(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      const n = await lockNotice(tx, ctx, scope, input.id, input.version);
      if (n.status !== "PUBLISHED") throw new ConflictError(n.status === "DRAFT" ? "A draft isn't published. Delete it instead." : "This notice is already withdrawn.");
      await tx.notice.update({ where: { id: n.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date(), withdrawnById: ctx.userId, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "notice.withdraw", entityType: "Notice", entityId: n.id });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── attachment (drafts only) ─────────────────────────────

/** Adds or replaces a draft's attachment. Scope is checked BEFORE the file is stored; images lose their metadata. */
export async function attachNoticeFile(ctx: AuthContext, input: NoticeRefInput, file: { bytes: Uint8Array; fileName: string }) {
  const scope = requireManage(ctx);
  // Cheap check first (no blob written for out-of-scope callers or published notices); repeated under the locks.
  const peek = await prisma.notice.findUnique({ where: { id: input.id }, select: { audience: true, scope: true, status: true, academicSessionId: true, createdById: true, targets: { select: { sectionId: true } } } });
  if (!peek) throw new NotFoundError(NOT_FOUND);
  const sections = await noticeSections(prisma, peek.academicSessionId, peek.targets.flatMap((t) => (t.sectionId ? [t.sectionId] : [])));
  if (!mayWriteNotice(scope, ctx.userId, { audience: peek.audience, scope: peek.scope, createdById: peek.createdById, sections })) throw new NotFoundError(NOT_FOUND);
  assertDraft(peek);
  let bytes = file.bytes;
  const detected = detectFileType(bytes);
  if (detected === "image/jpeg" || detected === "image/png") bytes = await stripDocumentImageMetadata(bytes, detected);
  const prepared: PreparedUpload = await prepareUpload(ctx, ATTACHMENT, bytes, file.fileName, { type: OWNER_TYPE, id: input.id });
  try {
    await prisma.$transaction(async (tx) => {
      const n = await lockNotice(tx, ctx, scope, input.id, input.version);
      assertDraft(n);
      assertSessionWritable(n.sessionStatus); // review 6C-M1 L3: no files on a draft that can never be published
      const stored = await recordUpload(tx, ctx, prepared);
      await tx.notice.update({ where: { id: n.id }, data: { attachmentFileId: stored.id, version: { increment: 1 } } });
      if (n.attachmentFileId) await retireStoredFile(tx, ctx, n.attachmentFileId);
      await audit(tx, actorOf(ctx), { action: n.attachmentFileId ? "notice.attachment_replace" : "notice.attachment_add", entityType: "Notice", entityId: n.id, after: { fileId: stored.id, mimeType: prepared.mimeType, sizeBytes: prepared.sizeBytes } });
    });
  } catch (e) {
    await discardUpload(prepared); // storage and database stay consistent
    busy(e);
  }
}

export async function removeNoticeAttachment(ctx: AuthContext, input: NoticeRefInput) {
  const scope = requireManage(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      const n = await lockNotice(tx, ctx, scope, input.id, input.version);
      assertDraft(n);
      if (!n.attachmentFileId) throw new NotFoundError("This notice has no attachment.");
      await tx.notice.update({ where: { id: n.id }, data: { attachmentFileId: null, version: { increment: 1 } } });
      await retireStoredFile(tx, ctx, n.attachmentFileId);
      await audit(tx, actorOf(ctx), { action: "notice.attachment_remove", entityType: "Notice", entityId: n.id });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── manager reads ─────────────────────────────

const LIST_SELECT = {
  id: true,
  version: true,
  title: true,
  audience: true,
  scope: true,
  status: true,
  publishAt: true,
  expiresAt: true,
  createdAt: true,
  attachmentFileId: true,
  academicSession: { select: { name: true, status: true, endDate: true } },
  _count: { select: { targets: true, reads: true } },
} as const;

/** Notices the caller manages in a session, newest first (drafts included). */
export async function listManagedNotices(ctx: AuthContext, academicSessionId: string) {
  const scope = requireManage(ctx);
  const rows = await prisma.notice.findMany({
    where: { academicSessionId, ...(scope === "ASSIGNED" ? ownSectionNotices(ctx.userId) : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIST_LIMIT,
    select: LIST_SELECT,
  });
  const [now, today] = [new Date(), await schoolToday()];
  return rows.map(({ _count, attachmentFileId, academicSession, ...r }) => ({
    ...r,
    state: noticeState({ ...r, sessionEnd: iso(academicSession.endDate) }, now, today),
    targets: _count.targets,
    reads: _count.reads,
    hasAttachment: attachmentFileId !== null,
  }));
}

async function targetLabels(n: { academicSessionId: string; scope: NoticeScope; targets: { classId: string | null; sectionId: string | null }[] }) {
  if (n.scope === "SECTION") return (await noticeSections(prisma, n.academicSessionId, n.targets.flatMap((t) => (t.sectionId ? [t.sectionId] : [])))).map((s) => ({ id: s.id, label: s.code }));
  if (n.scope === "CLASS") return (await noticeClasses(prisma, n.targets.flatMap((t) => (t.classId ? [t.classId] : [])))).map((c) => ({ id: c.id, label: c.name }));
  return [];
}

/** One managed notice with its targets, attachment and read receipts. Not managed by the caller → NotFound. */
export async function getManagedNotice(ctx: AuthContext, id: string) {
  const scope = requireManage(ctx);
  const n = await prisma.notice.findFirst({
    where: { id, ...(scope === "ASSIGNED" ? ownSectionNotices(ctx.userId) : {}) },
    select: {
      ...LIST_SELECT,
      academicSessionId: true,
      body: true,
      publishedAt: true,
      withdrawnAt: true,
      createdBy: { select: { displayName: true } },
      attachment: { select: { mimeType: true, sizeBytes: true, deletedAt: true } },
      targets: { select: { classId: true, sectionId: true } },
    },
  });
  if (!n) throw new NotFoundError(NOT_FOUND);
  const families = n.audience !== "STAFF";
  const audience: FamilyAudience = {
    academicSessionId: n.academicSessionId,
    ...(n.scope === "SECTION" ? { sectionIds: n.targets.flatMap((t) => (t.sectionId ? [t.sectionId] : [])) } : {}),
    ...(n.scope === "CLASS" ? { classIds: n.targets.flatMap((t) => (t.classId ? [t.classId] : [])) } : {}),
  };
  // Review 6C-M1 L1: family reads are counted with the reach's own rule (in the audience now), so the ratio is ≤ 100 %;
  // student accounts (P14) are counted on their own.
  const [labels, familyReads, studentReads, staffReads, reach] = await Promise.all([
    targetLabels(n),
    families ? prisma.noticeRead.count({ where: { noticeId: n.id, user: familyAccountWhere(audience) } }) : Promise.resolve(0),
    families ? prisma.noticeRead.count({ where: { noticeId: n.id, user: { studentId: { not: null } } } }) : Promise.resolve(0),
    prisma.noticeRead.count({ where: { noticeId: n.id, user: { guardianId: null, studentId: null } } }),
    families ? countFamilyAccounts(prisma, audience) : Promise.resolve(0),
  ]);
  const now = new Date();
  return {
    id: n.id,
    version: n.version,
    title: n.title,
    body: n.body,
    audience: n.audience,
    scope: n.scope,
    status: n.status,
    state: noticeState({ ...n, sessionEnd: iso(n.academicSession.endDate) }, now, await schoolToday()),
    publishAt: n.publishAt,
    /** The planned / actual publication time is still ahead (a draft would be "scheduled" if published now). */
    publishesLater: n.publishAt !== null && n.publishAt > now,
    expiresAt: n.expiresAt,
    publishedAt: n.publishedAt,
    withdrawnAt: n.withdrawnAt,
    createdAt: n.createdAt,
    createdBy: n.createdBy?.displayName ?? null,
    session: { id: n.academicSessionId, name: n.academicSession.name, closed: n.academicSession.status === "CLOSED" },
    targets: labels,
    attachment: n.attachment && !n.attachment.deletedAt ? { mimeType: n.attachment.mimeType, sizeBytes: n.attachment.sizeBytes } : null,
    receipts: { familyReads, familyReach: reach, studentReads, staffReads, families, staff: n.audience !== "FAMILIES" },
  };
}

// ───────────────────────────── staff readers ─────────────────────────────

function requireStaffReader(ctx: AuthContext) {
  if (ctx.portal || !hasPermission(ctx, "notice.read")) throw new ForbiddenError();
}

/** Live notices for staff (STAFF / ALL, always school-wide), newest first, with the caller's own read state. */
export async function listStaffNotices(ctx: AuthContext) {
  requireStaffReader(ctx);
  const rows = await prisma.notice.findMany({
    where: { ...liveWhere(new Date(), await schoolToday()), audience: { in: STAFF_AUDIENCES } },
    orderBy: [{ publishAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, title: true, publishAt: true, expiresAt: true, attachmentFileId: true, reads: { where: { userId: ctx.userId }, select: { readAt: true } } },
  });
  return rows.map((r) => ({ id: r.id, title: r.title, publishAt: r.publishAt, expiresAt: r.expiresAt, hasAttachment: r.attachmentFileId !== null, read: r.reads.length > 0 }));
}

/**
 * Opens a live staff notice and records the read receipt (once per user). Anything else → NotFound.
 * `recordRead: false` when the page was opened from another site (review 6C-M1 L2: a link elsewhere isn't a read).
 */
export async function openStaffNotice(ctx: AuthContext, id: string, opts: { recordRead: boolean } = { recordRead: true }) {
  requireStaffReader(ctx);
  const n = await prisma.notice.findFirst({
    where: { id, ...liveWhere(new Date(), await schoolToday()), audience: { in: STAFF_AUDIENCES } },
    select: { id: true, title: true, body: true, publishAt: true, expiresAt: true, attachment: { select: { mimeType: true, sizeBytes: true, deletedAt: true } } },
  });
  if (!n) throw new NotFoundError(NOT_FOUND);
  if (opts.recordRead) await prisma.noticeRead.createMany({ data: [{ noticeId: n.id, userId: ctx.userId }], skipDuplicates: true });
  const { attachment, ...rest } = n;
  return { ...rest, attachment: attachment && !attachment.deletedAt ? { mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes } : null };
}

/**
 * GET /api/v1/notices/[id]/attachment — staff: a live staff notice's attachment, or any notice the caller manages
 * (preview before publishing). Then the file layer: purpose, exact owner and `notice.read`. Anything else → NotFound.
 */
export async function readNoticeAttachment(ctx: AuthContext, id: string) {
  if (ctx.portal || !hasPermission(ctx, "notice.read")) throw new NotFoundError("Attachment not found.");
  const scope = manageScopeOf(ctx);
  const n = await prisma.notice.findFirst({
    where: {
      id,
      OR: [
        { ...liveWhere(new Date(), await schoolToday()), audience: { in: STAFF_AUDIENCES } },
        ...(scope === "ALL" ? [{}] : scope === "ASSIGNED" ? [ownSectionNotices(ctx.userId)] : []),
      ],
    },
    select: { attachmentFileId: true },
  });
  if (!n?.attachmentFileId) throw new NotFoundError("Attachment not found.");
  const file = await readStoredFile(ctx, n.attachmentFileId, { purpose: ATTACHMENT, owner: { type: OWNER_TYPE, id } });
  const ext = file.mimeType === "application/pdf" ? "pdf" : file.mimeType === "image/png" ? "png" : "jpg";
  return { ...file, originalName: `notice.${ext}` };
}
