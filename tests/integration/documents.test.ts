import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { bigintSafe } from "../bigint-json";

/**
 * PENDING until TEST_DATABASE_URL (Neon "test" branch, migrated incl. 20261109000000) is configured —
 * skipped otherwise. Issued-document registry: hashed codes, PRIVATE PDFs, ownership-bound reads,
 * revocation (document.revoke is separate from document.generate). Uses the in-memory storage driver.
 */
// KI-043: runs only via `npm run test:integration` (explicit opt-in) AND with TEST_DATABASE_URL.
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/rbac/catalog")),
  ...(await import("@/lib/rbac/authorize")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/storage/driver")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/verification-code")),
  ...(await import("@/modules/files/files.service")),
  ...(await import("@/modules/documents/documents.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

describe.skipIf(!enabled)("generated documents (integration)", () => {
  const run = `gd${Date.now().toString(36)}`;
  let adminCtx: Awaited<ReturnType<typeof m.validateSessionToken>>;
  let teacherCtx: Awaited<ReturnType<typeof m.validateSessionToken>>;
  let principalCtx: Awaited<ReturnType<typeof m.validateSessionToken>>;
  const issuedIds: string[] = [];

  async function ctxFor(userId: string) {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }

  beforeAll(async () => {
    const { prisma } = m;
    m.setStorageDriverForTests(new m.MemoryDriver());
    // KI-044: full catalog (82 / 13 / 271) in one batched transaction, verified exactly — no user, no Super Admin.
    await (await import("./catalog-setup")).ensureCatalog();
    const [admin, teacher, principal] = await Promise.all([
      prisma.role.findUniqueOrThrow({ where: { key: "SCHOOL_ADMIN" } }),
      prisma.role.findUniqueOrThrow({ where: { key: "TEACHER" } }),
      prisma.role.findUniqueOrThrow({ where: { key: "PRINCIPAL" } }),
    ]);
    const a = await prisma.user.create({ data: { username: `${run}-adm`, displayName: "Admin", passwordHash: "x", roles: { create: { roleId: admin.id } } } });
    const t = await prisma.user.create({ data: { username: `${run}-t`, displayName: "Teacher", passwordHash: "x", roles: { create: { roleId: teacher.id } } } });
    adminCtx = await ctxFor(a.id);
    teacherCtx = await ctxFor(t.id);
    const p = await prisma.user.create({ data: { username: `${run}-p`, displayName: "Principal", passwordHash: "x", roles: { create: { roleId: principal.id } } } });
    principalCtx = await ctxFor(p.id);
  });

  afterAll(async () => {
    const { prisma } = m;
    const docs = await prisma.generatedDocument.findMany({ where: { id: { in: issuedIds } }, select: { fileId: true } });
    await prisma.generatedDocument.deleteMany({ where: { id: { in: issuedIds } } });
    await prisma.storedFile.deleteMany({ where: { id: { in: docs.map((d) => d.fileId!).filter(Boolean) } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    m.setStorageDriverForTests(undefined);
    await prisma.$disconnect();
  });

  async function issue(subjectId: string) {
    let printed = "";
    const r = await m.issueDocument(adminCtx!, { type: "CERTIFICATE", subject: { type: "Student", id: subjectId }, fileName: "certificate.pdf" }, async (code) => {
      printed = code;
      return PDF;
    });
    issuedIds.push(r.id);
    return { ...r, printed };
  }

  it("prints the code on the PDF, stores only its hash, and keeps the PDF PRIVATE and owned", async () => {
    const r = await issue(`${run}-studentA`);
    expect(r.printed).toBe(r.verificationCode);
    const row = await m.prisma.generatedDocument.findUniqueOrThrow({ where: { id: r.id }, include: { file: true } });
    expect(row.verificationCodeHash).toBe(m.hashVerificationCode(m.normalizeVerificationCode(r.verificationCode)!, row.verificationKeyVersion));
    expect(row.verificationKeyVersion).toBe(m.currentVerificationKeyVersion());
    expect(JSON.stringify(row)).not.toContain(r.verificationCode.replace(/-/g, ""));
    expect(row.file!.visibility).toBe("PRIVATE");
    expect(row.file!.encrypted).toBe(true);
    expect([row.file!.purpose, row.file!.ownerType, row.file!.ownerId]).toEqual(["document.pdf", "GeneratedDocument", r.id]);
    const auditRows = await m.prisma.auditLog.findMany({ where: { entityId: r.id } });
    expect(JSON.stringify(auditRows, bigintSafe)).not.toContain(r.verificationCode.replace(/-/g, ""));
  });

  it("verifies with minimal information, accepting typed variations", async () => {
    const r = await issue(`${run}-studentB`);
    const v = await m.verifyDocument(r.verificationCode.toLowerCase().replace(/-/g, " "));
    expect(v.status).toBe("valid");
    expect(Object.keys(v).sort()).toEqual(["issuedOn", "issuer", "status", "type"]);
    expect(await m.verifyDocument("0000-0000-0000-0000")).toEqual({ status: "not_found" });
  });

  it("a revoked document fails verification; revoking twice conflicts", async () => {
    const r = await issue(`${run}-studentC`);
    // School Admin issued it but may not revoke it (document.revoke is separate).
    await expect(m.revokeDocument(adminCtx!, r.id, "Issued with a typo")).rejects.toBeInstanceOf(m.ForbiddenError);
    expect((await m.verifyDocument(r.verificationCode)).status).toBe("valid");
    await m.revokeDocument(principalCtx!, r.id, "Issued with a typo");
    expect(await m.verifyDocument(r.verificationCode)).toEqual({ status: "revoked" });
    await expect(m.revokeDocument(principalCtx!, r.id, "again")).rejects.toBeInstanceOf(m.ConflictError);
    const row = await m.prisma.generatedDocument.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.revokedById).toBe(principalCtx!.userId);
    expect(await m.prisma.auditLog.count({ where: { action: "document.revoke", entityId: r.id } })).toBe(1);
  });

  it("the PDF is never public and is bound to its own registry entry", async () => {
    const a = await issue(`${run}-studentD`);
    const b = await issue(`${run}-studentE`);
    const fileA = (await m.prisma.generatedDocument.findUniqueOrThrow({ where: { id: a.id } })).fileId!;
    await expect(m.readStoredFile(null, fileA)).rejects.toBeInstanceOf(m.NotFoundError); // public route
    await expect(m.readStoredFile(adminCtx!, fileA)).rejects.toBeInstanceOf(m.NotFoundError); // no owner given
    await expect(m.readStoredFile(adminCtx!, fileA, { purpose: "document.pdf", owner: { type: "GeneratedDocument", id: b.id } })).rejects.toBeInstanceOf(m.NotFoundError);
    const ok = await m.readStoredFile(adminCtx!, fileA, { purpose: "document.pdf", owner: { type: "GeneratedDocument", id: a.id } });
    expect(Buffer.from(ok.bytes).equals(PDF)).toBe(true);
  });

  it("teachers can neither issue nor revoke", async () => {
    await expect(m.issueDocument(teacherCtx!, { type: "OTHER", subject: { type: "Student", id: "x1" }, fileName: "x.pdf" }, async () => PDF)).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.revokeDocument(teacherCtx!, issuedIds[0], "nope")).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("the database refuses a raw (non-hash) verification code", async () => {
    await expect(
      m.prisma.generatedDocument.create({ data: { type: "OTHER", verificationCodeHash: "7K3MQ9TX2B4RHJ6N".padEnd(64, "0"), verificationKeyVersion: 1, subjectType: "Student", subjectId: "x" } }),
    ).rejects.toThrow();
  });
});
