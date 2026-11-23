import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { canLinkGuardians, guardianSearchSchema, linkGuardianSchema, mergeGuardiansSchema } from "@/modules/students/guardian-links.service";
import { guardianInvitationSchema } from "@/modules/students/family-accounts.schemas";

/** Phase 6A-M3b — email invitations and guardian link / merge (P4, P18): who may, schemas, static guards. */

const roleCtx = (roleKey: string): AuthContext => {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
};

describe("who may link or merge guardians", () => {
  it("only roles holding portal.account.manage + student.update + student.read at ALL", () => {
    const allowed = ROLES.map((r) => r.key).filter((k) => canLinkGuardians(roleCtx(k)));
    expect(allowed.sort()).toEqual(["SCHOOL_ADMIN", "SUPER_ADMIN"]);
  });
});

describe("schemas", () => {
  it("search by an exact 10-digit number; strict link / merge / invitation inputs", () => {
    expect(guardianSearchSchema.safeParse({ studentId: "s", phone: "9876543210" }).success).toBe(true);
    expect(guardianSearchSchema.safeParse({ studentId: "s", phone: "98765" }).success).toBe(false);
    expect(linkGuardianSchema.safeParse({ studentId: "s", guardianId: "g", relation: "UNCLE" }).success).toBe(false);
    expect(mergeGuardiansSchema.safeParse({ studentId: "s", keepGuardianId: "a", removeGuardianId: "b", extra: 1 }).success).toBe(false);
    expect(mergeGuardiansSchema.parse({ studentId: "s", keepGuardianId: "a", removeGuardianId: "b" }).confirmDifferent).toBe(false);
    expect(guardianInvitationSchema.parse({ studentId: "s", guardianId: "g", username: "" }).username).toBeNull();
  });
});

describe("emailAvailable", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("off when the provider is none, or the log preview runs in production", async () => {
    const { emailAvailable } = await import("@/lib/email");
    vi.stubEnv("EMAIL_PROVIDER", "none");
    expect(await emailAvailable()).toBe(false);
    vi.stubEnv("EMAIL_PROVIDER", "log");
    vi.stubEnv("NODE_ENV", "production");
    expect(await emailAvailable()).toBe(false);
    vi.stubEnv("NODE_ENV", "test");
    expect(await emailAvailable()).toBe(true);
    // Review L4: Resend without its key / sender is "unavailable" before anything is committed.
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await emailAvailable()).toBe(false);
  });
});

const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readFileSync(join(ROOT, "src", ...p), "utf8");

describe("static guards", () => {
  const links = src("modules", "students", "guardian-links.service.ts");
  const merge = links.slice(links.indexOf("export async function mergeGuardians"));

  it("merge: students locked before guardians; same number only; never removes a record with a portal account", () => {
    expect(merge.indexOf("lockAnyStudents(tx")).toBeLessThan(merge.indexOf('lockRows(tx, "guardian"'));
    expect(merge).toMatch(/keep\.phone !== remove\.phone/);
    expect(merge).toMatch(/if \(accounts\.has\(remove\.id\)\)/);
    // A portal block is never lost: the kept link allows the portal view only if both did.
    expect(merge).toMatch(/portalAccess: k\.portalAccess && l\.portalAccess/);
    expect(merge).toMatch(/admissionGuardian\.updateMany\(\{ where: \{ linkGuardianId: remove\.id, application:/);
    expect(merge).toMatch(/guardian\.update\(\{ where: \{ id: remove\.id \}, data: \{ deletedAt: new Date\(\) \} \}\)/);
  });

  it("review H1: links need the same mobile number and start blocked while any guardian of the student is blocked", () => {
    const link = links.slice(links.indexOf("export async function linkGuardianToStudent"), links.indexOf("export async function mergeGuardians"));
    expect(link).toMatch(/c\.guardian\.phone === guardian\.phone/);
    expect(link).toMatch(/const portalAccess = !current\.some\(\(c\) => !c\.portalAccess\)/);
    expect(link).not.toMatch(/studentGuardian\.create\(\{ data: \{[^}]*portalAccess: true/);
  });

  it("review M3 / L3: merge locks soft-deleted students too, detects concurrent changes, repoints only open applications", () => {
    expect(merge).toMatch(/lockAnyStudents\(tx,/);
    expect(merge).toMatch(/some\(\(l\) => !lockedStudents\.has\(l\.studentId\)\)\) throw new ConflictError/);
    expect(merge).toMatch(/status: \{ in: \["DRAFT", "SUBMITTED", "UNDER_REVIEW"\] \}/);
    expect(merge).toMatch(/if \(different && !input\.confirmDifferent\)/);
  });

  it("audit rows carry ids and counts only (no phone, name or email)", () => {
    for (const call of links.match(/audit\(tx,[\s\S]*?\}\);/g) ?? []) expect(call).not.toMatch(/phone|email|name/i);
  });

  it("invitation: email availability checked before any code is issued; fragment link; activated accounts refused", () => {
    const f = src("modules", "students", "family-accounts.service.ts");
    const inv = f.slice(f.indexOf("export async function sendFamilyInvitation"), f.indexOf("export async function issueSectionSlips"));
    expect(inv.indexOf("emailAvailable()")).toBeLessThan(inv.indexOf("$transaction"));
    expect(inv).toMatch(/\/activate#u=\$\{encodeURIComponent/);
    expect(inv).not.toMatch(/\/activate\?/);
    expect(inv).toMatch(/if \(existing\.activatedAt \|\| existing\.everActivated\) throw new ConflictError/); // review M1
    expect(inv).toMatch(/action: "guardian\.update"/); // review M2: recent contact changes by someone else
    expect(inv).toMatch(/latest\.actorId !== ctx\.userId/);
    expect(inv.indexOf("APP_URL")).toBeLessThan(inv.indexOf("emailAvailable()")); // review L7
    expect(inv).toMatch(/channel: "EMAIL"/);
    expect(inv.indexOf("sendEmail(")).toBeGreaterThan(inv.indexOf("$transaction"));
  });
});
