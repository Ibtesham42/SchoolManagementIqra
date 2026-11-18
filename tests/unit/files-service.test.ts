import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { MemoryDriver, setStorageDriverForTests } from "@/lib/storage/driver";
import { isUploadPurpose, LEGACY_PURPOSE, UPLOAD_RULES } from "@/lib/storage/upload-rules";
import { ForbiddenError, ValidationError } from "@/lib/errors";

const { prepareUpload, discardUpload, canReadStoredFile } = await import("@/modules/files/files.service");

const LOGO_OWNER = { type: "SchoolSetting", id: "default" };
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
/** Minimal JPEG (SOI, APP0/JFIF, EOI) — enough for magic-byte detection. */
const JPEG_SAMPLE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

function ctx(perms: string[], opts: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "u1", username: "u", displayName: "U", sessionId: "s", roleKeys: ["X"], isSuperAdmin: false,
    permissions: buildPermissionMap(perms.map((p) => ({ roleKey: "X", isSystem: false, permissionKey: p, scope: "ALL" as const }))),
    ...opts,
  };
}

let driver: MemoryDriver;
beforeEach(() => {
  driver = new MemoryDriver();
  setStorageDriverForTests(driver);
});
afterEach(() => setStorageDriverForTests(undefined));

describe("prepareUpload (school.logo)", () => {
  it("requires settings.manage before anything is written", async () => {
    await expect(prepareUpload(ctx(["settings.read"]), "school.logo", PNG, "logo.png", LOGO_OWNER)).rejects.toBeInstanceOf(ForbiddenError);
    expect(driver.blobs.size).toBe(0);
  });
  it("rejects disallowed content before anything is written", async () => {
    await expect(prepareUpload(ctx(["settings.manage"]), "school.logo", Buffer.from("<html><body>x</body></html>"), "logo.png", LOGO_OWNER)).rejects.toBeInstanceOf(ValidationError);
    expect(driver.blobs.size).toBe(0);
  });
  it("stores a valid logo as a PUBLIC, unencrypted blob with detected type and checksum", async () => {
    const p = await prepareUpload(ctx(["settings.manage"]), "school.logo", PNG, "../my logo.png", LOGO_OWNER);
    expect(p.visibility).toBe("PUBLIC");
    expect(p.encrypted).toBe(false);
    expect(p.mimeType).toBe("image/png");
    expect(p.originalName).toBe("my logo.png");
    expect(p.storageKey).toMatch(/^public\/\d{4}\/\d{2}\//);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.owner).toEqual(LOGO_OWNER);
    expect(p.purpose).toBe("school.logo");
    expect(Buffer.compare(await driver.get(p.storageKey), PNG)).toBe(0);
    await discardUpload(p);
    expect(driver.blobs.size).toBe(0);
  });
  it("refuses an owner of the wrong record type (a logo can't be filed under a student)", async () => {
    await expect(prepareUpload(ctx(["settings.manage"]), "school.logo", PNG, "l.png", { type: "Student", id: "s1" })).rejects.toBeInstanceOf(ValidationError);
    await expect(prepareUpload(ctx(["settings.manage"]), "school.logo", PNG, "l.png", { type: "SchoolSetting", id: "../x" })).rejects.toBeInstanceOf(ValidationError);
    expect(driver.blobs.size).toBe(0);
  });
  it("a forced password change blocks uploads even for Super Admin", async () => {
    await expect(prepareUpload(ctx([], { isSuperAdmin: true, mustChangePassword: true }), "school.logo", PNG, "l.png", LOGO_OWNER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("prepareUpload (document.pdf)", () => {
  const owner = { type: "GeneratedDocument", id: "d1" };
  it("stores generated PDFs PRIVATE and encrypted — the blob is never plaintext", async () => {
    const p = await prepareUpload(ctx(["document.generate"]), "document.pdf", PDF, "certificate.pdf", owner);
    expect(p.visibility).toBe("PRIVATE");
    expect(p.encrypted).toBe(true);
    expect(p.storageKey).toMatch(/^private\//);
    const stored = await driver.get(p.storageKey);
    expect(stored.includes(Buffer.from("%PDF"))).toBe(false);
    // Matches the stored_file_private_encrypted CHECK: PRIVATE ⇒ encrypted AND key_version set.
    expect(p.keyVersion).toBeGreaterThanOrEqual(1);
  });
  it("every PRIVATE upload purpose produces encrypted, versioned blobs; PUBLIC ones don't", async () => {
    for (const [purpose, rule] of Object.entries(UPLOAD_RULES)) {
      // A sample of a type the purpose accepts (e.g. "student.photo" stores re-encoded JPEG only).
      const allowed: readonly string[] = rule.allowed;
      const bytes = allowed.includes("application/pdf") ? PDF : allowed.includes("image/png") ? PNG : JPEG_SAMPLE;
      const owner = { type: rule.ownerType, id: "o1" };
      const p = await prepareUpload(ctx([rule.uploadPermission]), purpose as keyof typeof UPLOAD_RULES, bytes, "f", owner);
      expect(p.encrypted).toBe(rule.visibility === "PRIVATE");
      expect(p.keyVersion !== null).toBe(rule.visibility === "PRIVATE");
      expect(p.storageKey.startsWith(rule.visibility === "PRIVATE" ? "private/" : "public/")).toBe(true);
    }
  });
  it("requires document.generate and a PDF", async () => {
    await expect(prepareUpload(ctx(["settings.manage"]), "document.pdf", PDF, "x.pdf", owner)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prepareUpload(ctx(["document.generate"]), "document.pdf", PNG, "x.pdf", owner)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("canReadStoredFile — purpose and ownership", () => {
  const pub = { visibility: "PUBLIC" as const, purpose: "school.logo", ownerType: "SchoolSetting", ownerId: "default" };
  // A PRIVATE generated PDF owned by registry entry d1 (e.g. student A's certificate).
  const docA = { visibility: "PRIVATE" as const, purpose: "document.pdf", ownerType: "GeneratedDocument", ownerId: "d1" };
  const accessA = { purpose: "document.pdf" as const, owner: { type: "GeneratedDocument", id: "d1" } };
  const accessB = { purpose: "document.pdf" as const, owner: { type: "GeneratedDocument", id: "d2" } };
  const reader = ctx(["document.generate"]);

  it("PUBLIC: anyone, including anonymous visitors", () => {
    expect(canReadStoredFile(null, pub)).toBe(true);
  });
  it("PRIVATE: never anonymous, never without an owner the caller authorized", () => {
    expect(canReadStoredFile(null, docA, accessA)).toBe(false);
    expect(canReadStoredFile(reader, docA)).toBe(false); // generic /api/v1/files/:id passes no owner
  });
  it("PRIVATE: allowed only for the exact owner + purpose + read permission", () => {
    expect(canReadStoredFile(reader, docA, accessA)).toBe(true);
  });
  it("blocks another owner's file even with a valid permission (id tampering)", () => {
    // Caller authorized document d2 (student B) but asks for d1's file id.
    expect(canReadStoredFile(reader, docA, accessB)).toBe(false);
    expect(canReadStoredFile(reader, docA, { purpose: "document.pdf", owner: { type: "Student", id: "d1" } })).toBe(false);
  });
  it("blocks a purpose mismatch and a missing read permission", () => {
    expect(canReadStoredFile(reader, docA, { purpose: "school.logo", owner: accessA.owner })).toBe(false);
    expect(canReadStoredFile(ctx(["settings.manage"]), docA, accessA)).toBe(false);
  });
  it("uploading a file grants no right to read it later", () => {
    expect(canReadStoredFile(ctx([], { userId: "uploader" }), docA)).toBe(false);
  });
  it("legacy/unknown purposes: Super Admin only", () => {
    const legacy = { visibility: "PRIVATE" as const, purpose: "unclassified", ownerType: null, ownerId: null };
    expect(canReadStoredFile(reader, legacy, accessA)).toBe(false);
    expect(canReadStoredFile(ctx([], { isSuperAdmin: true }), legacy)).toBe(true);
  });
  it("Super Admin reads any private file, but not while a password change is forced", () => {
    expect(canReadStoredFile(ctx([], { isSuperAdmin: true }), docA)).toBe(true);
    expect(canReadStoredFile(ctx([], { isSuperAdmin: true, mustChangePassword: true }), docA, accessA)).toBe(false);
    expect(canReadStoredFile(ctx(["document.generate"], { mustChangePassword: true }), docA, accessA)).toBe(false);
  });
});

describe("legacy 'unclassified' files (rows that predate purposes)", () => {
  // Migration 20261109000000 backfills them with the sentinel owner ("LegacyFile", <file id>). The
  // owner-less shape is kept as a regression case. Neither may be readable by non–Super Admins.
  const legacyNoOwner = { visibility: "PRIVATE" as const, purpose: LEGACY_PURPOSE, ownerType: null, ownerId: null };
  const legacySentinel = { visibility: "PRIVATE" as const, purpose: LEGACY_PURPOSE, ownerType: "LegacyFile", ownerId: "f1" };
  const manyPerms = ctx(["document.generate", "student.document.read", "settings.manage", "employee.read"]);

  it("is not an upload purpose: nothing new can be filed as unclassified", () => {
    expect(isUploadPurpose(LEGACY_PURPOSE)).toBe(false);
    expect(isUploadPurpose("school.logo")).toBe(true);
    expect(isUploadPurpose("__proto__")).toBe(false);
    expect(isUploadPurpose("toString")).toBe(false);
  });
  it.each([
    ["no owner", legacyNoOwner],
    ["sentinel owner", legacySentinel],
  ])("%s: denied to anonymous users and non–Super Admins whatever access they claim", (_l, file) => {
    expect(canReadStoredFile(null, file)).toBe(false);
    expect(canReadStoredFile(manyPerms, file)).toBe(false);
    expect(canReadStoredFile(manyPerms, file, { purpose: "document.pdf", owner: { type: "LegacyFile", id: "f1" } })).toBe(false);
    expect(canReadStoredFile(manyPerms, file, { purpose: "school.logo", owner: { type: "LegacyFile", id: "f1" } })).toBe(false);
  });
  it("a legacy row marked PUBLIC is still Super Admin–only (nothing vouches for its content)", () => {
    const legacyPublic = { visibility: "PUBLIC" as const, purpose: LEGACY_PURPOSE, ownerType: "LegacyFile", ownerId: "f2" };
    expect(canReadStoredFile(null, legacyPublic)).toBe(false);
    expect(canReadStoredFile(manyPerms, legacyPublic)).toBe(false);
    expect(canReadStoredFile(ctx([], { isSuperAdmin: true }), legacyPublic)).toBe(true);
  });
  it("Super Admin only (audited by readStoredFile), and not with a forced password change", () => {
    expect(canReadStoredFile(ctx([], { isSuperAdmin: true }), legacyNoOwner)).toBe(true);
    expect(canReadStoredFile(ctx([], { isSuperAdmin: true }), legacySentinel)).toBe(true);
    expect(canReadStoredFile(ctx([], { isSuperAdmin: true, mustChangePassword: true }), legacySentinel)).toBe(false);
  });
  it("a PUBLIC purpose can never unlock a file stored PRIVATE", () => {
    const privateLogoShaped = { visibility: "PRIVATE" as const, purpose: "school.logo", ownerType: "SchoolSetting", ownerId: "default" };
    expect(canReadStoredFile(ctx(["settings.manage"]), privateLogoShaped, { purpose: "school.logo", owner: { type: "SchoolSetting", id: "default" } })).toBe(false);
  });
});
