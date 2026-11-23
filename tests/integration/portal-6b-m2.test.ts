import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6B-M2 — report cards and homework for families against the real database (PHASE_6_PLAN.md §6 6B-M2; review
 * 6B-M2 M1). PENDING until KI-059. Synthetic data only.
 * - unpublished exams invisible (list and by id); another family's real card id → the same 404 as a missing one;
 *   the PDF is the published SNAPSHOT (a later scale rename changes nothing) and says PARENT COPY; audited as a view;
 * - attachments: own current section only; another section, outside the window, deleted, blocked link, leaver and an
 *   old session after promotion → the same 404; a non-identifying file name.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/storage/driver")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/academic/results.portal")),
  ...(await import("@/modules/academic/homework.portal")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("portal report cards and homework (integration)", () => {
  const run = `p6m2${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2000 + Math.floor(Math.random() * 20);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, principal: Ctx, officer: Ctx, parentA: Ctx, parentB: Ctx;
  let sessionId: string, classId: string, sectionA: string, sectionB: string, classSubjectId: string, scaleId: string;
  const kid: Record<string, { studentId: string; guardianId: string; enrollmentId: string }> = {};
  const card: Record<string, string> = {};
  const hw: Record<string, string> = {};
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const window = { today: `${year}-10-15`, leaverAccessDays: 180 };
  let seq = 0;

  async function staff(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  async function parentOf(suffix: string, guardianId: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "PARENT" } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", privacyConsentAt: new Date(), guardianId, roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function admit(firstName: string, sectionId: string) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName: "Example", dob: "2015-05-01", gender: "FEMALE" });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: [{ relation: "MOTHER", name: `Synthetic Parent ${firstName}`, phone: `106${String(Date.now() % 1e6).padStart(6, "0")}${seq++ % 10}`, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionId);
    const { studentId } = await m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-04-01`, duplicateOverride: null, guardianLinks: {} });
    const { guardianId } = await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId }, select: { guardianId: true } });
    const { id: enrollmentId } = await m.prisma.studentEnrollment.findFirstOrThrow({ where: { studentId, academicSessionId: sessionId }, select: { id: true } });
    return { studentId, guardianId, enrollmentId };
  }
  const snapshotFor = (name: string) => ({
    v: 1,
    exam: { name: "Synthetic Term 1", session: "S", startDate: null, endDate: null },
    student: { code: `STU-${name}`, name: `Synthetic ${name}`, rollNumber: null, className: "Class", sectionCode: "A" },
    scale: "Synthetic Scale As Published",
    subjects: [],
    total: { obtained: "0", max: 0, percent: null, grade: null, result: "NO_RESULT" },
    rank: null,
    attendance: { marked: 0, percent: null },
  });
  async function homework(sectionId: string, title: string, dueOn: string, opts: { file?: boolean; deleted?: boolean; sessionId?: string; classSubjectId?: string } = {}) {
    const h = await m.prisma.homework.create({
      data: { academicSessionId: opts.sessionId ?? sessionId, sectionId, classSubjectId: opts.classSubjectId ?? classSubjectId, title, details: "Synthetic details", assignedOn: d(dueOn), dueOn: d(dueOn), deletedAt: opts.deleted ? new Date() : null },
    });
    if (opts.file) {
      const key = `test/${run}/${randomBytes(6).toString("hex")}.pdf`;
      const bytes = new TextEncoder().encode("%PDF-1.4 synthetic");
      await m.getStorageDriver().put(key, bytes);
      await m.prisma.storedFile.create({ data: { visibility: "PRIVATE", provider: "local", storageKey: key, originalName: "9B_Synthetic_Pupil_list.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, sha256: "0".repeat(64), purpose: "homework.attachment", ownerType: "Homework", ownerId: h.id } });
    }
    return h.id;
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [root, principal, officer] = await Promise.all([staff("root", "SUPER_ADMIN"), staff("pr", "PRINCIPAL"), staff("ao", "ADMISSION_OFFICER")]);
    sessionId = (await m.createAcademicSession(root, { name: `${year}-${String((year + 1) % 100).padStart(2, "0")}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(root, sessionId, "ACTIVE");
    classId = (await m.createClass(root, { code: `${tag}-R`, name: `${run} Class R`, numericLevel: 4, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    [sectionA, sectionB] = (await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A", "B"], capacity: 40 })).map((s) => s.id);
    const subject = await m.prisma.subject.create({ data: { code: `${tag}SUB`, name: `${run} Subject`, nameKey: `${run} subject` } });
    classSubjectId = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId, subjectId: subject.id } })).id;
    scaleId = (await m.prisma.gradeScale.create({ data: { name: `${run} Scale`, nameKey: `${run} scale` } })).id;
    kid.A = await admit("Anya", sectionA);
    kid.B = await admit("Bhavna", sectionB);
    kid.L = await admit("Lina", sectionA);
    parentA = await parentOf("pa", kid.A.guardianId);
    parentB = await parentOf("pb", kid.B.guardianId);
    const published = await m.prisma.examination.create({ data: { academicSessionId: sessionId, name: `${run} Term 1`, nameKey: `${run} term 1`, gradeScaleId: scaleId, status: "PUBLISHED", publishedAt: new Date() } });
    const locked = await m.prisma.examination.create({ data: { academicSessionId: sessionId, name: `${run} Term 2`, nameKey: `${run} term 2`, gradeScaleId: scaleId, status: "LOCKED" } });
    for (const k of ["A", "B"]) card[k] = (await m.prisma.reportCard.create({ data: { academicSessionId: sessionId, examinationId: published.id, enrollmentId: kid[k].enrollmentId, snapshot: snapshotFor(k) } })).id;
    card.unpublished = (await m.prisma.reportCard.create({ data: { academicSessionId: sessionId, examinationId: locked.id, enrollmentId: kid.A.enrollmentId, snapshot: snapshotFor("A") } })).id;
    hw.own = await homework(sectionA, "Own section", `${year}-10-20`, { file: true });
    hw.otherSection = await homework(sectionB, "Other section", `${year}-10-20`, { file: true });
    hw.old = await homework(sectionA, "Long past", `${year}-09-01`, { file: true });
    hw.deleted = await homework(sectionA, "Deleted", `${year}-10-20`, { file: true, deleted: true });
  }, 180_000);

  it("report cards: published only; another family's real id is the same 404 as a missing one", async () => {
    const list = await m.listPortalReportCards(parentA, kid.A.studentId, window);
    expect(list.map((c) => c.id)).toEqual([card.A]);
    const errs = await Promise.all([card.B, card.unpublished, "c0000000000000000000000000"].map((id) => m.renderPortalReportCardPdf(parentA, id, window).catch((e: Error) => e)));
    for (const e of errs) {
      expect(e).toBeInstanceOf(m.NotFoundError);
      expect((e as Error).message).toBe("Not found.");
    }
  });

  it("the PDF is the published snapshot, stamped PARENT COPY, audited as a view", async () => {
    await m.prisma.gradeScale.update({ where: { id: scaleId }, data: { name: `${run} Scale Renamed Later` } });
    const { pdf, fileName } = await m.renderPortalReportCardPdf(parentA, card.A, window);
    expect(fileName).toBe("report-card.pdf");
    const { extractTextRuns, pageText } = await import("../pdf-text");
    const text = pageText(extractTextRuns(pdf), 1);
    expect(text).toContain("PARENT COPY");
    expect(text).not.toContain("Renamed Later");
    expect(await m.prisma.auditLog.count({ where: { action: "report_card.portal_view", entityId: card.A, actorId: parentA.userId } })).toBe(1);
  });

  it("attachments: own current section inside the window only; everything else the same 404; non-identifying name", async () => {
    const file = await m.readPortalHomeworkAttachment(parentA, hw.own, window);
    expect(file.originalName).toBe("homework.pdf");
    for (const id of [hw.otherSection, hw.old, hw.deleted, "c0000000000000000000000000"]) {
      await expect(m.readPortalHomeworkAttachment(parentA, id, window)).rejects.toThrow("Not found.");
    }
    await expect(m.readPortalHomeworkAttachment(parentB, hw.own, window)).rejects.toThrow("Not found.");
  });

  it("attachments: a blocked link, a leaver and an old session after promotion are refused", async () => {
    const parentL = await parentOf("pl", kid.L.guardianId);
    await m.prisma.student.update({ where: { id: kid.L.studentId }, data: { status: "WITHDRAWN" } });
    await m.prisma.studentStatusChange.create({ data: { studentId: kid.L.studentId, fromStatus: "ACTIVE", toStatus: "WITHDRAWN", reason: "Synthetic", effectiveDate: d(`${year}-10-01`) } });
    await expect(m.readPortalHomeworkAttachment(parentL, hw.own, window)).rejects.toThrow("Not found.");
    // Promotion: B's homework of the old session is refused once B's current enrollment is in the new session.
    const next = (await m.createAcademicSession(root, { name: `${year + 1}-${String((year + 2) % 100).padStart(2, "0")}`, startDate: `${year + 1}-04-01`, endDate: `${year + 2}-03-31` })).id;
    const [newSection] = await m.createSectionsBulk(root, { academicSessionId: next, classId, names: ["C"], capacity: 40 });
    await m.prisma.studentEnrollment.update({ where: { id: kid.B.enrollmentId }, data: { status: "PROMOTED" } });
    await m.prisma.studentEnrollment.create({ data: { studentId: kid.B.studentId, academicSessionId: next, sectionId: newSection.id, enrolledOn: d(`${year + 1}-04-01`) } });
    await expect(m.readPortalHomeworkAttachment(parentB, hw.otherSection, window)).rejects.toThrow("Not found.");
    // Blocked link (P24): the next request of parent A no longer reaches A's homework.
    await m.prisma.studentGuardian.update({ where: { studentId_guardianId: { studentId: kid.A.studentId, guardianId: kid.A.guardianId } }, data: { portalAccess: false } });
    const fresh = (await m.validateSessionToken((await m.createSession(parentA.userId, { long: false })).token))!;
    await expect(m.readPortalHomeworkAttachment(fresh, hw.own, window)).rejects.toThrow("Not found.");
  });
});
