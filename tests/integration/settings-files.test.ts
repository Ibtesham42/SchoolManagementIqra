import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * PENDING until TEST_DATABASE_URL (Neon "test" branch, migrated) is configured — skipped otherwise.
 * Phase 2a: school profile, logo upload/download/retire, legacy files and file CHECK constraints,
 * academic session lifecycle, School Admin permissions — real
 * transactions, audit rows and rollback. Uses the in-memory storage driver; mutates the singleton
 * settings row, so run only against the disposable test branch.
 */
// KI-043: runs only via `npm run test:integration` (explicit opt-in) AND with TEST_DATABASE_URL.
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/crypto")),
  ...(await import("@/lib/db")),
  ...(await import("@/lib/rbac/catalog")),
  ...(await import("@/lib/rbac/authorize")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/storage/driver")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/files/files.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

describe.skipIf(!enabled)("school settings, files and sessions (integration)", () => {
  const run = `sf${Date.now().toString(36)}`;
  // Far-future, run-specific years so repeated runs never overlap each other or real sessions.
  const baseYear = 2200 + Math.floor(Math.random() * 600);
  const sessionName = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
  const range = (y: number) => ({ name: sessionName(y), startDate: `${y}-04-01`, endDate: `${y + 1}-03-31` });
  let superCtx: Awaited<ReturnType<typeof m.validateSessionToken>>;
  let teacherCtx: Awaited<ReturnType<typeof m.validateSessionToken>>;
  let previousCurrent: string | null = null;
  let driver: InstanceType<typeof m.MemoryDriver>;
  const createdSessionIds: string[] = [];

  async function ctxFor(userId: string) {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }

  beforeAll(async () => {
    const { prisma } = m;
    driver = new m.MemoryDriver();
    m.setStorageDriverForTests(driver);
    // KI-044: full catalog (82 / 13 / 271) in one batched transaction, verified exactly — no user, no Super Admin.
    await (await import("./catalog-setup")).ensureCatalog();
    const [sa, teacher] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } }),
      prisma.role.findUniqueOrThrow({ where: { key: "TEACHER" } }),
    ]);
    const root = await prisma.user.create({ data: { username: `${run}-root`, displayName: "Root", passwordHash: "x", roles: { create: { roleId: sa.id } } } });
    const t = await prisma.user.create({ data: { username: `${run}-t`, displayName: "Teacher", passwordHash: "x", roles: { create: { roleId: teacher.id } } } });
    superCtx = await ctxFor(root.id);
    teacherCtx = await ctxFor(t.id);
    previousCurrent = (await prisma.schoolSetting.findUnique({ where: { id: "default" }, select: { currentAcademicSessionId: true } }))?.currentAcademicSessionId ?? null;
  });

  afterAll(async () => {
    const { prisma } = m;
    await prisma.schoolSetting.updateMany({ where: { id: "default" }, data: { currentAcademicSessionId: previousCurrent } });
    await prisma.academicSession.deleteMany({ where: { id: { in: createdSessionIds } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    m.setStorageDriverForTests(undefined);
    await prisma.$disconnect();
  });

  const profile = () => ({
    name: "Demo Public School",
    shortCode: "DPS",
    affiliationNo: "",
    board: "CBSE",
    email: "office@example.test",
    website: "",
    phones: ["9876543210"],
    address: { line1: "1 Example Road", line2: "", city: "Sampletown", district: "", state: "Example State", pinCode: "110001", country: "India" },
    timezone: "Asia/Kolkata",
    locale: "en-IN" as const,
    currency: "INR",
    dateFormat: "DD/MM/YYYY" as const,
    timings: { opensAt: "08:00", closesAt: "14:00", officeHours: "" },
  });

  it("saves the school profile (Super Admin) with an audit row, and forbids a teacher", async () => {
    await m.updateSchoolProfile(superCtx!, profile());
    const row = await m.getSchoolSettings(superCtx!);
    expect(row?.name).toBe("Demo Public School");
    expect(await m.prisma.auditLog.count({ where: { action: "settings.profile_update", actorId: superCtx!.userId } })).toBeGreaterThan(0);
    await expect(m.updateSchoolProfile(teacherCtx!, profile())).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("uploads a logo, serves it publicly, and retires the previous one on replacement", async () => {
    await m.setSchoolLogo(superCtx!, PNG, "logo.png");
    const first = (await m.getSchoolSettings(superCtx!))!.logoFileId!;
    const served = await m.readStoredFile(null, first); // also fills the public-file cache
    expect(served.mimeType).toBe("image/png");
    expect(Buffer.from(served.bytes).equals(PNG)).toBe(true);

    await m.setSchoolLogo(superCtx!, PNG, "logo2.png");
    const second = (await m.getSchoolSettings(superCtx!))!.logoFileId!;
    expect(second).not.toBe(first);
    expect((await m.prisma.storedFile.findUniqueOrThrow({ where: { id: first }, select: { deletedAt: true } })).deletedAt).not.toBeNull();
    await expect(m.readStoredFile(null, first)).rejects.toBeInstanceOf(m.NotFoundError); // retire evicted the cache entry

    await m.removeSchoolLogo(superCtx!);
    expect((await m.getSchoolSettings(superCtx!))!.logoFileId).toBeNull();
  });

  it("rejects a non-image logo without creating a file row", async () => {
    const before = await m.prisma.storedFile.count();
    await expect(m.setSchoolLogo(superCtx!, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "logo.png")).rejects.toBeInstanceOf(m.ValidationError);
    expect(await m.prisma.storedFile.count()).toBe(before);
  });

  it("legacy 'unclassified' files stay Super Admin–only and can still be retired", async () => {
    // A real blob, encrypted like any PRIVATE file, so the Super Admin read below exercises the full path.
    const storageKey = `private/2026/01/${run}legacyAAAAAAAAAA`;
    const plain = Buffer.from("%PDF-1.7 legacy synthetic\n");
    const enc = m.encryptBuffer(plain);
    await driver.put(storageKey, enc.data);
    const legacy = await m.prisma.storedFile.create({
      data: { visibility: "PRIVATE", provider: "memory", storageKey, originalName: "old.pdf", mimeType: "application/pdf", sizeBytes: plain.length, sha256: m.sha256Hex(plain), encrypted: true, keyVersion: enc.keyVersion, purpose: "unclassified", ownerType: "LegacyFile", ownerId: "placeholder" },
      select: { id: true }, // explicit select: independent of columns added later (e.g. purged_at, S-15)
    });
    await m.prisma.storedFile.update({ where: { id: legacy.id }, data: { ownerId: legacy.id } }); // as the backfill does
    await expect(m.readStoredFile(teacherCtx!, legacy.id, { purpose: "document.pdf", owner: { type: "LegacyFile", id: legacy.id } })).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.readStoredFile(null, legacy.id)).rejects.toBeInstanceOf(m.NotFoundError);
    const asSuper = await m.readStoredFile(superCtx!, legacy.id);
    expect(asSuper.publiclyReadable).toBe(false); // route sends Cache-Control: private, no-store
    expect(Buffer.from(asSuper.bytes).equals(plain)).toBe(true); // decrypted from the stored blob
    // Updating a legacy row (soft delete) satisfies every CHECK — the KI-039 regression.
    await m.prisma.$transaction((tx) => m.retireStoredFile(tx, superCtx!, legacy.id));
    expect((await m.prisma.storedFile.findUniqueOrThrow({ where: { id: legacy.id }, select: { deletedAt: true } })).deletedAt).not.toBeNull();
    await m.prisma.storedFile.delete({ where: { id: legacy.id } });
  });

  // Explicit selects below: the only possible failure is the CHECK under test, not an unrelated column (S-15).
  it("the database refuses PRIVATE files that are unencrypted, unversioned or ownerless", async () => {
    const base = { visibility: "PRIVATE" as const, provider: "memory", originalName: "x.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: "0".repeat(64), purpose: "document.pdf" };
    const key = (n: string) => `private/2026/01/${run}${n}AAAAAAAAAAAA`;
    await expect(m.prisma.storedFile.create({ data: { ...base, storageKey: key("a"), encrypted: false, keyVersion: null, ownerType: "GeneratedDocument", ownerId: "d1" }, select: { id: true } })).rejects.toThrow();
    await expect(m.prisma.storedFile.create({ data: { ...base, storageKey: key("b"), encrypted: true, keyVersion: null, ownerType: "GeneratedDocument", ownerId: "d1" }, select: { id: true } })).rejects.toThrow();
    await expect(m.prisma.storedFile.create({ data: { ...base, storageKey: key("c"), encrypted: true, keyVersion: 1 }, select: { id: true } })).rejects.toThrow();
    await expect(m.prisma.storedFile.create({ data: { ...base, storageKey: key("d"), encrypted: true, keyVersion: 1, ownerType: "GeneratedDocument" }, select: { id: true } })).rejects.toThrow();
  });

  it("runs the session lifecycle: create → edit → activate → current → close guard", async () => {
    const a = await m.createAcademicSession(superCtx!, range(baseYear));
    createdSessionIds.push(a.id);
    await m.updateAcademicSession(superCtx!, a.id, { ...range(baseYear), endDate: `${baseYear + 1}-03-30` });
    await m.changeAcademicSessionStatus(superCtx!, a.id, "ACTIVE");
    await m.setCurrentAcademicSession(superCtx!, a.id);
    expect((await m.listAcademicSessions(superCtx!)).currentId).toBe(a.id);
    // Active sessions are no longer editable; the current one cannot be closed.
    await expect(m.updateAcademicSession(superCtx!, a.id, range(baseYear))).rejects.toBeInstanceOf(m.ConflictError);
    await expect(m.changeAcademicSessionStatus(superCtx!, a.id, "CLOSED")).rejects.toBeInstanceOf(m.ConflictError);
  });

  it("School Admin can manage settings and sessions (owner decision), audited under their name", async () => {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "SCHOOL_ADMIN" } });
    const u = await m.prisma.user.create({ data: { username: `${run}-sa`, displayName: "School Admin", passwordHash: "x", roles: { create: { roleId: role.id } } } });
    const adminCtx = await ctxFor(u.id);
    await m.updateSchoolProfile(adminCtx, profile());
    const s2 = await m.createAcademicSession(adminCtx, range(baseYear + 3));
    createdSessionIds.push(s2.id);
    expect(await m.prisma.auditLog.count({ where: { actorId: u.id, action: { in: ["settings.profile_update", "session.create"] } } })).toBe(2);
  });

  it("refuses overlapping and duplicate sessions, and forbids a teacher", async () => {
    const overlap = { name: sessionName(baseYear + 1), startDate: `${baseYear + 1}-01-01`, endDate: `${baseYear + 2}-03-31` };
    await expect(m.createAcademicSession(superCtx!, overlap)).rejects.toBeInstanceOf(m.ConflictError);
    await expect(m.createAcademicSession(superCtx!, range(baseYear))).rejects.toBeInstanceOf(m.ConflictError);
    await expect(m.createAcademicSession(teacherCtx!, range(baseYear + 2))).rejects.toBeInstanceOf(m.ForbiddenError);
  });
});
