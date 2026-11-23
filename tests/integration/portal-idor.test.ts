import { beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6A-M4 — IDOR suite v1 (PHASE_6_PLAN.md §7), table-driven against the real database. PENDING until KI-059.
 * Resources in 6A: the child profile and the child list (switcher); plus the staff services behind the ERP pages and
 * every /api/v1 route in reach (photo, documents, report-card PDF, homework attachment, receipt PDF, export), which
 * must refuse every portal account identically for own and other children; unauthenticated calls. Each later portal
 * read (6B / 6C) adds its rows here. HTTP-level status / body for the pages is asserted in tests/e2e/portal.spec.ts.
 *
 * Actors: Parent A (children A1, A2), Parent B (B1), Parent A-blocked (second guardian of A1, blocked by the office),
 * Student A1 (own account), Parent L (child left 30 days ago) and Parent L-old (child left 200 days ago), staff.
 * Ids: own child, sibling, other family's child, soft-deleted student, nonexistent cuid, an id of another type.
 * Expected: allowed, or NotFound with the SAME message (no existence oracle).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/students/students.service")),
  ...(await import("@/modules/students/students.portal")),
  ...(await import("@/modules/academic/results.service")),
  ...(await import("@/modules/academic/homework.service")),
  ...(await import("@/modules/fees/receipts.service")),
  ...(await import("@/modules/students/student-attendance.portal")),
  ...(await import("@/modules/academic/timetable.portal")),
  ...(await import("@/modules/academic/calendar.portal")),
  ...(await import("@/modules/academic/results.portal")),
  ...(await import("@/modules/academic/homework.portal")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("portal IDOR suite v1 (integration)", () => {
  const run = `idor${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2000 + Math.floor(Math.random() * 20);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, principal: Ctx, officer: Ctx;
  let sessionId: string, classId: string, sectionId: string;
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  let seq = 0;
  const phone = () => `100${String(Date.now() % 1e6).padStart(6, "0")}${seq++ % 10}`; // "10x…": never a real Indian number
  const kids: Record<string, string> = {};
  const actors: Record<string, Ctx> = {};
  let otherTypeId: string;
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const window = { today, leaverAccessDays: 180 };

  const tokenCtx = async (userId: string) => (await m.validateSessionToken((await m.createSession(userId, { long: false })).token))!;
  async function staff(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return tokenCtx(u.id);
  }
  async function portal(suffix: string, roleKey: "PARENT" | "STUDENT", link: { guardianId?: string; studentId?: string }) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", privacyConsentAt: new Date(), ...link, roles: { create: { roleId: role.id } } } });
    return tokenCtx(u.id);
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function admit(firstName: string, guardianPhone = phone()) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName: "Example", dob: "2015-05-01", gender: "MALE" });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: [{ relation: "FATHER", name: `Synthetic Parent ${firstName}`, phone: guardianPhone, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionId);
    const { studentId } = await m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
    const { guardianId } = await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId }, select: { guardianId: true } });
    return { studentId, guardianId };
  }
  async function leave(studentId: string, on: string) {
    await m.prisma.student.update({ where: { id: studentId }, data: { status: "WITHDRAWN" } });
    await m.prisma.studentStatusChange.create({ data: { studentId, fromStatus: "ACTIVE", toStatus: "WITHDRAWN", reason: "Synthetic", effectiveDate: new Date(`${on}T00:00:00Z`) } });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [root, principal, officer] = await Promise.all([staff("root", "SUPER_ADMIN"), staff("pr", "PRINCIPAL"), staff("ao", "ADMISSION_OFFICER")]);
    actors.teacher = await staff("t", "TEACHER");
    actors.accountant = await staff("acc", "ACCOUNTANT");
    actors.superAdmin = root;
    sessionId = (await m.createAcademicSession(root, { name: `${year}-${String((year + 1) % 100).padStart(2, "0")}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(root, sessionId, "ACTIVE");
    classId = (await m.createClass(root, { code: `${tag}-I`, name: `${run} Class I`, numericLevel: 6, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    sectionId = (await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A"], capacity: 60 }))[0].id;

    const a1 = await admit("Arun");
    const a2 = await admit("Anil");
    await m.prisma.studentGuardian.create({ data: { studentId: a2.studentId, guardianId: a1.guardianId, relation: "FATHER" } });
    const b1 = await admit("Bala");
    const l1 = await admit("Lalit");
    const lo = await admit("Lokesh");
    const del = await admit("Dev");
    await m.prisma.studentGuardian.create({ data: { studentId: del.studentId, guardianId: a1.guardianId, relation: "FATHER" } });
    // A second guardian of A1, blocked by the office (P24).
    const blocked = await m.prisma.guardian.create({ data: { name: "Synthetic Blocked Parent", phone: phone() } });
    await m.prisma.studentGuardian.create({ data: { studentId: a1.studentId, guardianId: blocked.id, relation: "MOTHER", portalAccess: false } });
    await leave(l1.studentId, daysAgo(30));
    await leave(lo.studentId, daysAgo(200));
    await m.prisma.student.update({ where: { id: del.studentId }, data: { deletedAt: new Date() } });
    Object.assign(kids, { A1: a1.studentId, A2: a2.studentId, B1: b1.studentId, L1: l1.studentId, LO: lo.studentId, DEL: del.studentId });
    otherTypeId = a1.guardianId; // a well-formed id of another table

    actors.parentA = await portal("pa", "PARENT", { guardianId: a1.guardianId });
    actors.parentB = await portal("pb", "PARENT", { guardianId: b1.guardianId });
    actors.parentBlocked = await portal("pblk", "PARENT", { guardianId: blocked.id });
    actors.studentA1 = await portal("sa1", "STUDENT", { studentId: a1.studentId });
    actors.parentL = await portal("pl", "PARENT", { guardianId: l1.guardianId });
    actors.parentLOld = await portal("plo", "PARENT", { guardianId: lo.guardianId });
  }, 180_000);

  // ── profile: who may open which id ──
  const ALLOWED: Record<string, string[]> = {
    parentA: ["A1", "A2"],
    parentB: ["B1"],
    parentBlocked: [],
    studentA1: ["A1"],
    parentL: [], // leavers keep results / fees only (P17), never the profile
    parentLOld: [],
    teacher: [],
    accountant: [],
    superAdmin: [], // staff use the staff screens; portal reads refuse every non-portal context
  };
  const IDS = ["A1", "A2", "B1", "L1", "LO", "DEL", "MISSING", "OTHER_TYPE"] as const;
  const idOf = (k: (typeof IDS)[number]) => (k === "MISSING" ? "c0000000000000000000000000" : k === "OTHER_TYPE" ? otherTypeId : kids[k]);

  // Phase 6B-M1: attendance, timetable and calendar follow the same table (leavers see none of them, P17).
  const RESOURCES: Record<string, (ctx: Ctx, id: string) => Promise<unknown>> = {
    profile: (ctx, id) => m.getPortalStudentProfile(ctx, id, window),
    attendance: (ctx, id) => m.getPortalAttendanceMonth(ctx, { studentId: id }, window),
    timetable: (ctx, id) => m.getPortalTimetable(ctx, id, window),
    calendar: (ctx, id) => m.getPortalCalendarMonth(ctx, { studentId: id }, window),
    homework: (ctx, id) => m.listPortalHomework(ctx, id, window),
  };

  it("profile, attendance, timetable, calendar: allowed exactly for own children; everything else the identical NotFound", async () => {
    const outcomes: string[] = [];
    for (const [resource, read] of Object.entries(RESOURCES)) {
      for (const [actor, allowed] of Object.entries(ALLOWED)) {
        for (const k of IDS) {
          const r = await read(actors[actor], idOf(k)).then(
            () => "ok",
            (e: Error) => `${e.constructor.name}:${e.message}`,
          );
          const expected = allowed.includes(k) ? "ok" : "NotFoundError:Not found.";
          if (r !== expected) outcomes.push(`${resource} · ${actor} × ${k}: got ${r}, expected ${expected}`);
        }
      }
    }
    expect(outcomes).toEqual([]);
  });

  it("child list (switcher): own children only; leaver within the window listed without a profile; blocked / old leaver absent", async () => {
    const ids = async (a: string) => (await m.listPortalChildren(actors[a], window)).map((k) => `${Object.keys(kids).find((x) => kids[x] === k.id)}:${k.current ? "current" : "leaver"}`).sort();
    expect(await ids("parentA")).toEqual(["A1:current", "A2:current"]);
    expect(await ids("parentB")).toEqual(["B1:current"]);
    expect(await ids("parentBlocked")).toEqual([]);
    expect(await ids("studentA1")).toEqual(["A1:current"]);
    expect(await ids("parentL")).toEqual(["L1:leaver"]);
    expect(await ids("parentLOld")).toEqual([]);
    for (const staffActor of ["teacher", "accountant"]) await expect(m.listPortalChildren(actors[staffActor], window)).resolves.toEqual([]);
  });

  it("6B-M2 report cards: own children, and a leaver inside the window (P17); everything else the identical NotFound", async () => {
    const allowed: Record<string, string[]> = { ...ALLOWED, parentL: ["L1"] };
    const outcomes: string[] = [];
    for (const [actor, ids] of Object.entries(allowed)) {
      for (const k of IDS) {
        const r = await m.listPortalReportCards(actors[actor], idOf(k), window).then(() => "ok", (e: Error) => `${e.constructor.name}:${e.message}`);
        const expected = ids.includes(k) ? "ok" : "NotFoundError:Not found.";
        if (r !== expected) outcomes.push(`results · ${actor} × ${k}: got ${r}, expected ${expected}`);
      }
    }
    expect(outcomes).toEqual([]);
    // By record id: a card / homework id that isn't this account's (here: missing) is the same NotFound; staff are refused.
    await expect(m.renderPortalReportCardPdf(actors.parentA, "c0000000000000000000000000", window)).rejects.toThrow("Not found.");
    await expect(m.readPortalHomeworkAttachment(actors.parentA, "c0000000000000000000000000", window)).rejects.toThrow("Not found.");
    await expect(m.renderPortalReportCardPdf(actors.teacher, "c0000000000000000000000000", window)).rejects.toBeInstanceOf(m.AppError);
  });

  it("unauthenticated: portal reads refuse before any lookup", async () => {
    await expect(m.getPortalStudentProfile(null as never, kids.A1, window)).rejects.toBeInstanceOf(m.UnauthenticatedError);
    await expect(m.listPortalChildren(null as never, window)).rejects.toBeInstanceOf(m.UnauthenticatedError);
  });

  /**
   * Review 6A-M4 M2: the staff services behind every ERP page and /api/v1 route refuse portal accounts with the SAME
   * outcome for an own child and another family's child (403 / 404 at the route, never data). Photo, documents,
   * report-card PDF, homework attachment, receipt PDF and the student export are the API surfaces in reach.
   */
  it("staff reads and API services refuse every portal account, identically for own and other children", async () => {
    const refusal = (e: unknown) => (e instanceof m.ForbiddenError ? "Forbidden" : e instanceof m.NotFoundError ? "NotFound" : `UNEXPECTED ${String((e as Error)?.constructor?.name)}`);
    const attempt = async (f: () => Promise<unknown>) => f().then(() => "ALLOWED", refusal);
    const surfaces: Record<string, (ctx: Ctx, studentId: string) => Promise<unknown>> = {
      getStudent: (ctx, id) => m.getStudent(ctx, id),
      readStudentPhoto: (ctx, id) => m.readStudentPhoto(ctx, id),
      readStudentDocument: (ctx, id) => m.readStudentDocument(ctx, id, "c0000000000000000000000000"),
      listStudents: (ctx) => m.listStudents(ctx, { page: 1, pageSize: 25 } as never),
      exportStudentRows: (ctx) => m.exportStudentRows(ctx, {} as never),
      renderReportCardPdf: (ctx) => m.renderReportCardPdf(ctx, "c0000000000000000000000000"),
      readHomeworkAttachment: (ctx) => m.readHomeworkAttachment(ctx, "c0000000000000000000000000"),
      renderReceiptPdf: (ctx) => m.renderReceiptPdf(ctx, "c0000000000000000000000000"),
    };
    const problems: string[] = [];
    for (const a of ["parentA", "parentB", "studentA1"]) {
      for (const [name, call] of Object.entries(surfaces)) {
        const own = await attempt(() => call(actors[a], kids.A1));
        const other = await attempt(() => call(actors[a], kids.B1));
        if (own === "ALLOWED" || own.startsWith("UNEXPECTED") || own !== other) problems.push(`${a} × ${name}: own=${own}, other=${other}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("a stale child: unlinking in the middle of a session takes effect on the next request", async () => {
    const userId = actors.parentA.userId;
    const { token } = await m.createSession(userId, { long: false });
    const before = (await m.validateSessionToken(token))!;
    await m.getPortalStudentProfile(before, kids.A2, window);
    await m.prisma.studentGuardian.delete({ where: { studentId_guardianId: { studentId: kids.A2, guardianId: before.portal!.guardianId! } } });
    const after = (await m.validateSessionToken(token))!;
    await expect(m.getPortalStudentProfile(after, kids.A2, window)).rejects.toThrow("Not found.");
  });
});
