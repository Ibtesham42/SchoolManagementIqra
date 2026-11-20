import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 4C against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped without
 * TEST_DATABASE_URL): homework by the allocated teacher only, academic events, and promotion — proposal by the class
 * teacher, confirmation by School Admin creating next-session enrollments, detention, leaving with a status change,
 * capacity and timing refusals. Needs migrations 20261122000000 and 20261123000000 applied to the Test branch.
 * Homework needs a session that covers today; promotion uses a PAST session (confirmation is allowed from its last day).
 * Synthetic data; removed in afterAll except audit rows (append-only, S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/format")),
  ...(await import("@/modules/academic/homework.service")),
  ...(await import("@/modules/academic/calendar.service")),
  ...(await import("@/modules/students/promotion.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("Phase 4C homework, calendar and promotion (integration)", () => {
  const run = `pc${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const P = 1950 + Math.floor(Math.random() * 40); // past promotion session year
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, teacher: Ctx, otherTeacher: Ctx, classTeacher: Ctx;
  let nowSession: string, pastSession: string, nextSession: string, hwSection: string, csMath: string, csArt: string;
  let fromSection: string, nextA: string, sameB: string;
  const enr: string[] = [];
  const students: string[] = [];
  let cls8: string, cls9: string;

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    admin = await login((await user("admin", "SCHOOL_ADMIN")).id);
    const t = await user("t1", "TEACHER");
    const t1 = await linkTeachingEmployee(m.prisma, tag, t.id);
    teacher = await login(t.id);
    const o = await user("t2", "TEACHER");
    await linkTeachingEmployee(m.prisma, tag, o.id);
    otherTeacher = await login(o.id);
    const ct = await user("ct", "CLASS_TEACHER");
    await linkTeachingEmployee(m.prisma, tag, ct.id);
    classTeacher = await login(ct.id);

    const today = m.todayInTimeZone();
    const start = new Date(d(today).getTime() - 60 * 86_400_000);
    const end = new Date(d(today).getTime() + 200 * 86_400_000);
    nowSession = (await m.prisma.academicSession.create({ data: { name: `${run}-now`, startDate: start, endDate: end, status: "ACTIVE" } })).id;
    pastSession = (await m.prisma.academicSession.create({ data: { name: `${run}-${P}`, startDate: d(`${P}-04-01`), endDate: d(`${P + 1}-03-31`), status: "ACTIVE" } })).id;
    nextSession = (await m.prisma.academicSession.create({ data: { name: `${run}-${P + 1}`, startDate: d(`${P + 1}-04-01`), endDate: d(`${P + 2}-03-31`), status: "PLANNED" } })).id;
    cls8 = (await m.prisma.schoolClass.create({ data: { code: `${tag}C8`, name: `${run} eight`, nameKey: `${run} eight`, numericLevel: 8 } })).id;
    cls9 = (await m.prisma.schoolClass.create({ data: { code: `${tag}C9`, name: `${run} nine`, nameKey: `${run} nine`, numericLevel: 9 } })).id;
    const section = async (sess: string, classId: string, name: string, capacity = 40, classTeacherId: string | null = null) =>
      (await m.prisma.section.create({ data: { academicSessionId: sess, classId, name, nameKey: name.toLowerCase(), code: `${tag}${classId === cls8 ? "C8" : "C9"}-${name}`, capacity, classTeacherId } })).id;
    hwSection = await section(nowSession, cls8, "A");
    const subj = async (code: string) => (await m.prisma.subject.create({ data: { code: `${tag}${code}`, name: `${run} ${code}`, nameKey: `${run} ${code}`.toLowerCase() } })).id;
    const mat = await subj("MAT");
    const art = await subj("ART");
    csMath = (await m.prisma.classSubject.create({ data: { academicSessionId: nowSession, classId: cls8, subjectId: mat } })).id;
    csArt = (await m.prisma.classSubject.create({ data: { academicSessionId: nowSession, classId: cls8, subjectId: art } })).id;
    await m.prisma.teacherAllocation.create({ data: { academicSessionId: nowSession, sectionId: hwSection, classSubjectId: csMath, employeeId: t1 } });

    fromSection = await section(pastSession, cls8, "P", 40, ct.id);
    nextA = await section(nextSession, cls9, "A", 2);
    sameB = await section(nextSession, cls8, "B");
    for (let i = 1; i <= 4; i++) {
      const s = await m.prisma.student.create({
        data: {
          studentCode: `${tag}-STU-${i}`, admissionNo: `${tag}-ADM-${i}`, firstName: "Synthetic", fullName: `Synthetic Pupil ${i}`, fullNameNormalized: `synthetic pupil ${i}`,
          dob: d(`${P - 13}-06-01`), gender: "OTHER", admissionDate: d(`${P}-04-01`), admittedSessionId: pastSession,
        },
      });
      students.push(s.id);
      enr.push((await m.prisma.studentEnrollment.create({ data: { studentId: s.id, academicSessionId: pastSession, sectionId: fromSection, enrolledOn: d(`${P}-04-01`) } })).id);
    }
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const sessions = [nowSession, pastSession, nextSession].filter(Boolean);
    await prisma.promotionDecision.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.homework.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.academicEvent.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.teacherAllocation.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.studentStatusChange.deleteMany({ where: { studentId: { in: students } } });
    await prisma.student.deleteMany({ where: { studentCode: { startsWith: tag } } });
    await prisma.classSubject.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.section.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.subject.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: { in: sessions } } });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("homework: only the allocated teacher posts for their subject; due dates checked; soft removal", async () => {
    const today = m.todayInTimeZone();
    const later = iso(new Date(d(today).getTime() + 7 * 86_400_000));
    await expect(m.createHomework(otherTeacher, { sectionId: hwSection, classSubjectId: csMath, title: "T", details: "D", dueOn: later })).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.createHomework(teacher, { sectionId: hwSection, classSubjectId: csArt, title: "T", details: "D", dueOn: later })).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.createHomework(teacher, { sectionId: hwSection, classSubjectId: csMath, title: "T", details: "D", dueOn: "2000-01-01" })).rejects.toBeInstanceOf(m.ValidationError);
    const h = await m.createHomework(teacher, { sectionId: hwSection, classSubjectId: csMath, title: "Chapter 4", details: "Q1–Q5", dueOn: later });
    const view = await m.getSectionHomework(teacher, hwSection);
    expect(view.items.map((i) => i.id)).toEqual([h.id]);
    expect(view.subjects.filter((s) => s.canPost).map((s) => s.id)).toEqual([csMath]);
    await expect(m.getSectionHomework(otherTeacher, hwSection)).rejects.toBeInstanceOf(m.NotFoundError);
    await m.updateHomework(admin, { id: h.id, version: 1, title: "Chapter 4 (revised)", details: "Q1–Q6", dueOn: later });
    await expect(m.removeHomework(teacher, { id: h.id, version: 1 })).rejects.toThrow(/changed by someone else/);
    await m.removeHomework(teacher, { id: h.id, version: 2 });
    expect((await m.getSectionHomework(admin, hwSection)).items).toEqual([]);
    expect(await m.prisma.homework.count({ where: { id: h.id, deletedAt: { not: null } } })).toBe(1);
  });

  it("calendar: events inside the session only; the month view lists them; only academic.manage edits", async () => {
    const today = m.todayInTimeZone();
    await expect(m.createEvent(admin, { academicSessionId: nowSession, title: "Too early", startDate: "1900-01-01", endDate: null, details: null })).rejects.toBeInstanceOf(m.ValidationError);
    const e = await m.createEvent(admin, { academicSessionId: nowSession, title: "Sports day", startDate: today, endDate: null, details: "Synthetic" });
    const month = await m.getCalendarMonth(teacher, { academicSessionId: nowSession, month: today.slice(0, 7) });
    expect(month.entries.find((x) => x.kind === "event")).toMatchObject({ title: "Sports day", date: today, endDate: today });
    await expect(m.updateEvent(teacher, { id: e.id, version: 1, title: "X", startDate: today, endDate: null, details: null })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.deleteEvent(admin, { id: e.id, version: 1 });
    expect(await m.prisma.academicEvent.count({ where: { id: e.id } })).toBe(0);
  });

  it("promotion: class teacher proposes; admin confirms into the next session with capacity checks; leavers get a status change", async () => {
    await expect(m.getSectionPromotion(teacher, fromSection)).rejects.toBeInstanceOf(m.NotFoundError);
    const row = (i: number, decision: "PROMOTE" | "DETAIN" | "LEAVE", leaveAs: "TRANSFERRED" | null = null) => ({ enrollmentId: enr[i], decision, toClassId: null, leaveAs, version: null });
    await expect(m.proposePromotions(classTeacher, { sectionId: fromSection, entries: [row(0, "LEAVE")] })).rejects.toBeInstanceOf(m.ValidationError);
    await m.proposePromotions(classTeacher, { sectionId: fromSection, entries: [row(0, "PROMOTE"), row(1, "PROMOTE"), row(2, "PROMOTE"), row(3, "LEAVE", "TRANSFERRED")] });
    await expect(m.confirmPromotions(classTeacher, { sectionId: fromSection, targetSessionId: nextSession, targets: [] })).rejects.toBeInstanceOf(m.ForbiddenError);
    // Three promoted into a section with room for two → refused, nothing changed.
    await expect(m.confirmPromotions(admin, { sectionId: fromSection, targetSessionId: nextSession, targets: [{ classId: cls9, sectionId: nextA }] })).rejects.toThrow(/room for 2/);
    expect(await m.prisma.studentEnrollment.count({ where: { academicSessionId: nextSession } })).toBe(0);
    // Pupil 3 is detained instead.
    const view = await m.getSectionPromotion(classTeacher, fromSection);
    const v2 = view.rows.find((r) => r.enrollmentId === enr[2])!.decision!.version;
    await m.proposePromotions(classTeacher, { sectionId: fromSection, entries: [{ ...row(2, "DETAIN"), version: v2 }] });
    await expect(m.confirmPromotions(admin, { sectionId: fromSection, targetSessionId: nextSession, targets: [{ classId: cls9, sectionId: nextA }] })).rejects.toThrow(/Choose a section/);
    const r = await m.confirmPromotions(admin, { sectionId: fromSection, targetSessionId: nextSession, targets: [{ classId: cls9, sectionId: nextA }, { classId: cls8, sectionId: sameB }] });
    expect(r).toEqual({ promoted: 2, detained: 1, left: 1 });
    const old = await m.prisma.studentEnrollment.findMany({ where: { id: { in: enr } }, orderBy: { id: "asc" }, select: { id: true, status: true, leftOn: true } });
    const byId = new Map(old.map((o) => [o.id, o]));
    expect(byId.get(enr[0])).toMatchObject({ status: "PROMOTED", leftOn: d(`${P + 1}-03-31`) });
    expect(byId.get(enr[2])?.status).toBe("DETAINED");
    expect(byId.get(enr[3])?.status).toBe("LEFT");
    const next = await m.prisma.studentEnrollment.findMany({ where: { academicSessionId: nextSession }, select: { sectionId: true, enrolledOn: true, status: true } });
    expect(next.filter((n) => n.sectionId === nextA)).toHaveLength(2);
    expect(next.filter((n) => n.sectionId === sameB)).toHaveLength(1);
    expect(next.every((n) => n.status === "ACTIVE" && iso(n.enrolledOn) === `${P + 1}-04-01`)).toBe(true);
    expect((await m.prisma.student.findUniqueOrThrow({ where: { id: students[3] }, select: { status: true } })).status).toBe("TRANSFERRED");
    expect(await m.prisma.studentStatusChange.count({ where: { studentId: students[3], toStatus: "TRANSFERRED" } })).toBe(1);
    // Nothing left to confirm; confirmed decisions can't be changed.
    await expect(m.confirmPromotions(admin, { sectionId: fromSection, targetSessionId: nextSession, targets: [] })).rejects.toThrow(/No proposed promotions/);
    expect(await m.prisma.auditLog.count({ where: { action: "promotion.confirm", entityId: fromSection } })).toBe(1);
  });
});
