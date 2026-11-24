import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6C-M2 — in-app notifications against the real database (PHASE_6_PLAN.md §6 6C-M2). PENDING until KI-059.
 * Synthetic data only; the weekly-off setting is changed for the run and restored afterwards.
 * - one absence alert per child per day (re-marking doesn't duplicate); back-dated absences send nothing;
 * - a rolled-back write sends nothing; a blocked guardian and a never-activated account get nothing;
 * - a custody block clears that guardian's notifications about the child;
 * - fan-out of 1,200 rows is batched and idempotent; the inbox is the account's own; 90-day cleanup.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/format")),
  ...(await import("@/lib/maintenance")),
  ...(await import("@/modules/notifications/notifications.service")),
  ...(await import("@/modules/notifications/notifications.portal")),
  ...(await import("@/modules/students/student-attendance.service")),
  ...(await import("@/modules/students/family-accounts.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("notifications (integration)", () => {
  const run = `ntf${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let teacher: Ctx, admin: Ctx, parent: Ctx, blockedParentId: string, pendingParentId: string;
  let sessionId: string, sectionId: string, studentId: string, enrollmentId: string, guardianId: string;
  let today: string, yesterday: string, weeklyBefore: unknown;
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const shift = (s: string, days: number) => new Date(d(s).getTime() + days * 86_400_000).toISOString().slice(0, 10);

  async function staff(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  async function guardianWithAccount(suffix: string, opts: { activated: boolean; portalAccess: boolean }) {
    const g = await m.prisma.guardian.create({ data: { name: `Synthetic Guardian ${suffix}`, phone: `108${String(Date.now() % 1e6).padStart(6, "0")}${suffix.length}` } });
    await m.prisma.studentGuardian.create({ data: { studentId, guardianId: g.id, relation: "MOTHER", portalAccess: opts.portalAccess } });
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "PARENT" } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", guardianId: g.id, privacyConsentAt: opts.activated ? new Date() : null, roles: { create: { roleId: role.id } } } });
    return { guardianId: g.id, userId: u.id };
  }
  const mark = (status: "PRESENT" | "ABSENT", date: string, version: number | null) => m.markStudentDay(teacher, { sectionId, date, entries: [{ enrollmentId, status: status as "PRESENT", version }], reason: date === today ? "" : "Synthetic correction" });
  const markVersion = async (date: string) => (await m.prisma.studentAttendance.findFirst({ where: { enrollmentId, date: d(date) }, select: { version: true } }))?.version ?? null;
  const rows = (userId: string, prefix = "absence:") => m.prisma.notification.findMany({ where: { userId, dedupeKey: { startsWith: prefix } }, select: { id: true, dedupeKey: true, title: true, body: true, link: true, readAt: true } });

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [teacher, admin] = await Promise.all([staff("ct", "CLASS_TEACHER"), staff("sa", "SCHOOL_ADMIN")]);
    const s = await m.prisma.schoolSetting.findFirst({ select: { studentWeeklyOff: true, timezone: true } });
    weeklyBefore = s?.studentWeeklyOff ?? null;
    await m.prisma.schoolSetting.updateMany({ data: { studentWeeklyOff: { days: [], saturdays: [] } } }); // every day a school day
    today = m.todayInTimeZone(s?.timezone ?? undefined);
    yesterday = shift(today, -1);
    // A session around TODAY (absence alerts are same-day only). No holiday is created on these dates.
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-now`, startDate: d(shift(today, -30)), endDate: d(shift(today, 300)), status: "ACTIVE" } })).id;
    const cls = (await m.prisma.schoolClass.create({ data: { code: `${tag}N1`, name: `${run} one`, nameKey: `${run} one`, numericLevel: 1 } })).id;
    sectionId = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: cls, name: "A", nameKey: "a", code: `${tag}N1-A`, capacity: 40, classTeacherId: teacher.userId } })).id;
    const st = await m.prisma.student.create({
      data: { studentCode: `${tag}-STU-1`, admissionNo: `${tag}-ADM-1`, firstName: "Synthia", fullName: "Synthia Example", fullNameNormalized: "synthia example", dob: d("2018-06-01"), gender: "OTHER", admissionDate: d(shift(today, -30)), admittedSessionId: sessionId },
    });
    studentId = st.id;
    enrollmentId = (await m.prisma.studentEnrollment.create({ data: { studentId, academicSessionId: sessionId, sectionId, enrolledOn: d(shift(today, -30)) } })).id;
    const main = await guardianWithAccount("pa", { activated: true, portalAccess: true });
    guardianId = main.guardianId;
    parent = (await m.validateSessionToken((await m.createSession(main.userId, { long: false })).token))!;
    blockedParentId = (await guardianWithAccount("pblk", { activated: true, portalAccess: false })).userId;
    pendingParentId = (await guardianWithAccount("ppend", { activated: false, portalAccess: true })).userId;
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { user: { username: { startsWith: run } } } });
    await prisma.studentAttendance.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.studentGuardian.deleteMany({ where: { studentId } });
    await prisma.guardian.deleteMany({ where: { name: { startsWith: "Synthetic Guardian" }, students: { none: {} } } });
    await prisma.student.deleteMany({ where: { studentCode: { startsWith: tag } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.schoolSetting.updateMany({ data: { studentWeeklyOff: weeklyBefore === null ? { days: [], saturdays: [] } : (weeklyBefore as object) } });
    await prisma.$disconnect();
  }, 180_000);

  it("a rolled-back save sends nothing", async () => {
    await expect(mark("ABSENT", shift(today, 1), null)).rejects.toBeInstanceOf(m.ValidationError); // future date
    await expect(mark("ABSENT", today, 7)).rejects.toBeInstanceOf(m.ConflictError); // stale version
    expect(await rows(parent.userId)).toEqual([]);
  });

  it("one absence alert per child per day; only the activated, unblocked guardian; no details", async () => {
    await mark("ABSENT", today, null);
    let mine = await rows(parent.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ dedupeKey: `absence:${studentId}:${today}`, title: "Marked absent today", body: "Synthia was marked absent today.", link: `/portal/c/${studentId}/attendance` });
    expect(await rows(blockedParentId)).toEqual([]);
    expect(await rows(pendingParentId)).toEqual([]);
    // Corrected to present and back to absent the same day: still one.
    await mark("PRESENT", today, await markVersion(today));
    await mark("ABSENT", today, await markVersion(today));
    mine = await rows(parent.userId);
    expect(mine).toHaveLength(1);
  });

  it("back-dated absences send nothing", async () => {
    await mark("ABSENT", yesterday, await markVersion(yesterday));
    expect((await rows(parent.userId)).filter((r) => r.dedupeKey === `absence:${studentId}:${yesterday}`)).toEqual([]);
  });

  it("the inbox is the account's own: open marks read and returns a portal path; staff and other accounts get NotFound", async () => {
    const [n] = await rows(parent.userId);
    expect(await m.countPortalUnread(parent)).toBe(1);
    expect((await m.listPortalNotifications(parent)).map((x) => x.id)).toEqual([n.id]);
    await expect(m.openPortalNotification(teacher, n.id)).rejects.toBeInstanceOf(m.NotFoundError);
    const other = (await m.validateSessionToken((await m.createSession(blockedParentId, { long: false })).token))!;
    await expect(m.openPortalNotification(other, n.id)).rejects.toBeInstanceOf(m.NotFoundError);
    expect(await m.openPortalNotification(parent, n.id)).toBe(`/portal/c/${studentId}/attendance`);
    expect((await rows(parent.userId))[0].readAt).not.toBeNull();
    expect(await m.countPortalUnread(parent)).toBe(0);
  });

  it("review 6C-M2 M1–M3: rows the account may no longer see are hidden at read time (block, notice gone)", async () => {
    // A row about the child for an account whose link is blocked (e.g. after a guardian merge, or a fan-out race).
    const other = (await m.validateSessionToken((await m.createSession(blockedParentId, { long: false })).token))!;
    await m.deliver([{ userId: blockedParentId, type: "attendance.absent", title: "Marked absent today", body: "x", link: `/portal/c/${studentId}/attendance`, dedupeKey: `absence:${studentId}:${shift(today, -2)}` }]);
    expect(await m.listPortalNotifications(other)).toEqual([]);
    expect(await m.countPortalUnread(other)).toBe(0);
    // A notice notification whose notice isn't live for this family (withdrawn / missing).
    await m.deliver([{ userId: parent.userId, type: "notice.published", title: "New notice", body: "gone", link: "/portal/notices/c0000000000000000000000000", dedupeKey: "notice:c0000000000000000000000000" }]);
    expect((await m.listPortalNotifications(parent)).map((x) => x.body)).not.toContain("gone");
    expect(await m.forgetNoticeNotifications("c0000000000000000000000000")).toBeGreaterThanOrEqual(1);
  });

  it("a custody block clears that guardian's notifications about the child", async () => {
    expect((await rows(parent.userId)).length).toBe(1);
    await m.setGuardianPortalAccess(admin, { studentId, guardianId, portalAccess: false });
    expect(await rows(parent.userId)).toEqual([]);
    await m.setGuardianPortalAccess(admin, { studentId, guardianId, portalAccess: true });
  });

  it("fan-out of 1,200 rows is batched and idempotent; invalid links are dropped", async () => {
    const users = Array.from({ length: 1200 }, (_, i) => ({ username: `${run}-fan-${i}`, displayName: "Synthetic fan", passwordHash: "x" }));
    await m.prisma.user.createMany({ data: users });
    const ids = (await m.prisma.user.findMany({ where: { username: { startsWith: `${run}-fan-` } }, select: { id: true } })).map((u) => u.id);
    const drafts = ids.map((userId) => ({ userId, type: "notice.published" as const, title: "t", body: "b", link: "/portal/notices/x1", dedupeKey: `notice:${run}` }));
    expect(await m.deliver(drafts)).toBe(1200);
    expect(await m.deliver(drafts)).toBe(0);
    expect(await m.deliver([{ ...drafts[0], dedupeKey: `notice:${run}-bad`, link: "https://example.invalid/x" }])).toBe(0);
  }, 120_000);

  it("cleanup removes notifications older than 90 days only", async () => {
    const old = await m.prisma.notification.create({ data: { userId: parent.userId, type: "notice.published", title: "old", body: "old", link: "/portal/inbox", dedupeKey: `old:${run}`, createdAt: new Date(Date.now() - 91 * 86_400_000) } });
    const fresh = await m.prisma.notification.create({ data: { userId: parent.userId, type: "notice.published", title: "new", body: "new", link: "/portal/inbox", dedupeKey: `new:${run}` } });
    const r = await m.runCleanup();
    expect(r.notifications).toBeGreaterThanOrEqual(1);
    expect(await m.prisma.notification.count({ where: { id: old.id } })).toBe(0);
    expect(await m.prisma.notification.count({ where: { id: fresh.id } })).toBe(1);
  });
});
