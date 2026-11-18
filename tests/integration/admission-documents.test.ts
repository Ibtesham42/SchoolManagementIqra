import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { integrationEnabled } from "../test-scope";

/**
 * PENDING until migrations 20261110000000 + 20261111000000 are applied to the Neon "test" branch and
 * TEST_DATABASE_URL is configured (separate owner approval); skipped otherwise (KI-043). Phase 2B S4:
 * admission documents through the real service — encryption at rest, owner-bound reads, photo
 * re-encoding, replace/remove/verify, decided applications locked, RBAC, audit without contents.
 * In-memory storage driver; synthetic files only; everything removed in afterAll.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/storage/driver")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/admissions/documents.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("admission documents (integration)", () => {
  const run = `dc${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const baseYear = 2200 + Math.floor(Math.random() * 600);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, officer: Ctx, teacher: Ctx, accountant: Ctx;
  let driver: InstanceType<typeof m.MemoryDriver>;
  let sessionId: string, classId: string;
  const MARKER = "synthetic-gps-marker-77";
  const PDF = Buffer.from(`%PDF-1.7\n1 0 obj<<>>endobj\n% ${MARKER}\n%%EOF`);

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const draft = async () => (await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName: "Synthetic", middleName: null, lastName: `Doc${Math.random().toString(36).slice(2, 7)}`, dob: "2019-05-01", gender: "MALE" })).id;
  const photoWithGps = () =>
    sharp({ create: { width: 640, height: 480, channels: 3, background: "#884422" } })
      .withExif({ IFD0: { Copyright: MARKER }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "28/1 36/1 0/1" } })
      .jpeg()
      .toBuffer();

  beforeAll(async () => {
    driver = new m.MemoryDriver();
    m.setStorageDriverForTests(driver);
    await (await import("./catalog-setup")).ensureCatalog();
    const [root, ao, t, acc] = await Promise.all([user("root", "SUPER_ADMIN"), user("ao", "ADMISSION_OFFICER"), user("t", "TEACHER"), user("acc", "ACCOUNTANT")]);
    [admin, officer, teacher, accountant] = await Promise.all([ctxFor(root.id), ctxFor(ao.id), ctxFor(t.id), ctxFor(acc.id)]);
    const name = `${baseYear}-${String((baseYear + 1) % 100).padStart(2, "0")}`;
    sessionId = (await m.createAcademicSession(admin, { name, startDate: `${baseYear}-04-01`, endDate: `${baseYear + 1}-03-31` })).id;
    classId = (await m.createClass(admin, { code: `${tag}-D`, name: `${run} Class D`, numericLevel: 2, displayOrder: 0, defaultSectionCapacity: null }))!.id;
  });

  afterAll(async () => {
    const { prisma } = m;
    const apps = await prisma.admissionApplication.findMany({ where: { academicSessionId: sessionId }, select: { id: true } });
    const docs = await prisma.studentDocument.findMany({ where: { applicationId: { in: apps.map((a) => a.id) } }, select: { fileId: true } });
    await prisma.studentDocument.deleteMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
    await prisma.storedFile.deleteMany({ where: { id: { in: docs.map((d) => d.fileId) } } });
    await prisma.admissionApplication.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    m.setStorageDriverForTests(undefined);
    await prisma.$disconnect();
  });

  it("stores a PDF encrypted at rest, owned by its document row; audit holds no file name or contents", async () => {
    const app = await draft();
    const doc = await m.addApplicationDocument(officer, app, { type: "BIRTH_CERTIFICATE", label: null }, { bytes: PDF, fileName: "Ananya-birth-cert.pdf" });
    const row = await m.prisma.studentDocument.findUniqueOrThrow({ where: { id: doc.id }, include: { file: true } });
    expect([row.file.visibility, row.file.encrypted, row.file.ownerType, row.file.ownerId, row.file.purpose]).toEqual(["PRIVATE", true, "StudentDocument", doc.id, "student.document"]);
    const blob = await driver.get(row.file.storageKey);
    expect(blob.includes(Buffer.from(MARKER))).toBe(false); // ciphertext only
    const read = await m.readApplicationDocument(officer, app, doc.id);
    expect(Buffer.from(read.bytes).equals(PDF)).toBe(true);
    const audits = JSON.stringify(await m.prisma.auditLog.findMany({ where: { entityId: { in: [doc.id, row.fileId] } }, select: { action: true, after: true } }));
    expect(audits).toContain("document.upload");
    expect(audits).not.toContain("Ananya");
    expect(audits).not.toContain(MARKER);
  });

  it("photos are re-encoded: stored JPEG has no EXIF/GPS; a second photo retires the first", async () => {
    const app = await draft();
    const first = await m.addApplicationDocument(officer, app, { type: "PHOTO", label: null }, { bytes: await photoWithGps(), fileName: "IMG_0001.JPG" });
    const stored = await m.readApplicationDocument(officer, app, first.id);
    expect(stored.mimeType).toBe("image/jpeg");
    expect((await sharp(stored.bytes).metadata()).exif).toBeUndefined();
    expect(Buffer.from(stored.bytes).includes(Buffer.from(MARKER))).toBe(false);
    const second = await m.addApplicationDocument(officer, app, { type: "PHOTO", label: null }, { bytes: await photoWithGps(), fileName: "IMG_0002.JPG" });
    const current = await m.listApplicationDocuments(officer, app);
    expect(current.filter((d) => d.type === "PHOTO").map((d) => d.id)).toEqual([second.id]);
    await expect(m.readApplicationDocument(officer, app, first.id)).rejects.toBeInstanceOf(m.NotFoundError);
  });

  it("a failed photo stores nothing (no blob, no row)", async () => {
    const app = await draft();
    const blobsBefore = driver.blobs.size;
    await expect(m.addApplicationDocument(officer, app, { type: "PHOTO", label: null }, { bytes: Buffer.from("not an image"), fileName: "x.jpg" })).rejects.toBeInstanceOf(m.ValidationError);
    expect(driver.blobs.size).toBe(blobsBefore);
    expect(await m.prisma.studentDocument.count({ where: { applicationId: app } })).toBe(0);
  });

  it("owner-bound: a document id of another application is not found; teachers and the Accountant are refused", async () => {
    const a = await draft();
    const b = await draft();
    const doc = await m.addApplicationDocument(officer, a, { type: "OTHER", label: "Synthetic certificate" }, { bytes: PDF, fileName: "x.pdf" });
    await expect(m.readApplicationDocument(officer, b, doc.id)).rejects.toBeInstanceOf(m.NotFoundError);
    for (const ctx of [teacher, accountant]) {
      await expect(m.readApplicationDocument(ctx, a, doc.id)).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.addApplicationDocument(ctx, a, { type: "OTHER", label: "x" }, { bytes: PDF, fileName: "x.pdf" })).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.listApplicationDocuments(ctx, a)).rejects.toBeInstanceOf(m.ForbiddenError);
    }
  });

  it("verify and remove are audited; decided applications accept no document changes", async () => {
    const app = await draft();
    const doc = await m.addApplicationDocument(officer, app, { type: "TRANSFER_CERTIFICATE", label: null }, { bytes: PDF, fileName: "tc.pdf" });
    await m.verifyApplicationDocument(officer, app, doc.id);
    await expect(m.verifyApplicationDocument(officer, app, doc.id)).rejects.toBeInstanceOf(m.ConflictError);
    await m.removeApplicationDocument(officer, app, doc.id);
    const actions = (await m.prisma.auditLog.findMany({ where: { entityId: doc.id }, select: { action: true } })).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["document.upload", "document.verify", "document.remove"]));
    // Make the application final (REJECTED) directly for this check, then try to upload.
    await m.prisma.admissionApplication.update({ where: { id: app }, data: { status: "REJECTED", applicationNo: `APP-T-${run}`, rejectionReason: "synthetic", decidedAt: new Date() } });
    await expect(m.addApplicationDocument(officer, app, { type: "OTHER", label: "x" }, { bytes: PDF, fileName: "x.pdf" })).rejects.toBeInstanceOf(m.ConflictError);
  });
});
