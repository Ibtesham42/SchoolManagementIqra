import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { csvCell } from "@/lib/csv";
import { ForbiddenError, RateLimitedError, RequestTimeoutError, ValidationError } from "@/lib/errors";
import { readBodyWithLimit, UPLOAD_READ_TIMEOUT_MS } from "@/lib/http/upload";
import { errorStatus, UPLOAD_MESSAGES, uploadErrorCode } from "@/lib/http/upload-errors";
import { exportErrorCode } from "@/lib/http/export-errors";
import { TtlSet } from "@/lib/http/ttl-set";
import { assertBelowLimit, bucketKey, hit, hitLocal, LOCAL_LIMITER_MAX_KEYS, peek, resetLocalLimiterForTests, resetSubject, RULES, subjectPrefix } from "@/lib/rate-limit";
import { type AuthContext } from "@/lib/rbac/authorize";
import { ALLOWED_SCOPES, isScopeAllowed, normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { assertRunIdentity, E2E_TARGET, INTEGRATION_TARGET, resolveRunTarget, TargetGuardError } from "@/lib/db-target-guard";
import { assertScopesSupported } from "@/modules/identity/identity.policy";
import { assertNotSelfApproval, SELF_APPROVAL_MESSAGE } from "@/modules/admissions/admissions.rules";
import { assertExportSize, EXPORT_MAX_ROWS, exportFilterAudit } from "@/modules/students/students.rules";

/**
 * Phase 2B security fixes (docs/SECURITY_AUDIT_2026-11-10_PHASE_2B.md): S-01, S-03, S-04, S-05, S-06, S-08,
 * S-09, S-11, S-12, S-14 and the export hardening items. Offline: the rate limiter runs on its memory driver,
 * and service checks are proven to run BEFORE any database access (the lazy Prisma client throws
 * "DATABASE_URL is not set" if a function reaches the database in a unit run). Database behaviour of S-02,
 * S-03, S-09, S-13, S-14 is in tests/integration/security-fixes-2b.test.ts.
 */
const src = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

function ctxFor(roleKey: string, over: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const permissions = new Map<PermissionKey, Set<Scope>>();
  for (const g of role.grants) {
    const { key, scope } = normalizeGrant(g);
    permissions.set(key, (permissions.get(key) ?? new Set<Scope>()).add(scope));
  }
  return { userId: "u1", username: "synthetic", displayName: "Synthetic", roleKeys: [roleKey], isSuperAdmin: false, permissions, sessionId: "s1", ...over };
}
const custom = (grants: [PermissionKey, Scope][]): AuthContext => ({
  userId: "u2",
  username: "custom",
  displayName: "Custom",
  roleKeys: ["CUSTOM"],
  isSuperAdmin: false,
  permissions: new Map(grants.map(([k, s]) => [k, new Set([s])])),
  sessionId: "s2",
});

// ───────────────────────────── S-01 ─────────────────────────────
describe("S-01: upload body deadline", () => {
  it("a body that never finishes is rejected after the deadline and its stream cancelled", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(8)); // a few bytes, then nothing more, never closed
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBodyWithLimit(stalled, 1024, { timeoutMs: 40 })).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(cancelled).toBe(true);
  });
  it("a complete body inside the deadline is returned", async () => {
    const body = new Response("hello").body;
    expect(new TextDecoder().decode(await readBodyWithLimit(body, 1024, { timeoutMs: 1000 }))).toBe("hello");
  });
  it("timeout maps to a FIXED upload code and HTTP 408; default deadline 120 s", () => {
    expect(uploadErrorCode(new RequestTimeoutError())).toBe("too_slow");
    expect(UPLOAD_MESSAGES.too_slow).toMatch(/took too long/);
    expect(errorStatus(new RequestTimeoutError())).toBe(408);
    expect(UPLOAD_READ_TIMEOUT_MS).toBe(120_000);
  });
  it("the upload route checks permissions before the upload slot and the body read", () => {
    const route = src("src/app/api/v1/admissions/[id]/documents/route.ts");
    const gate = route.indexOf('hasPermission(ctx, "student.document.manage")');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(route.indexOf("slots.run("));
    expect(route).toMatch(/scopeFor\(ctx, "admission\.read"\) !== "ALL"/);
  });
});

// ───────────────────────────── S-03 ─────────────────────────────
describe("S-03: login limiter can't be used to lock a user out from elsewhere", () => {
  const prev = process.env.RATE_LIMIT_DRIVER;
  beforeAll(() => {
    process.env.RATE_LIMIT_DRIVER = "memory";
  });
  afterAll(() => {
    process.env.RATE_LIMIT_DRIVER = prev;
  });

  it("rules: per (username, IP) for every attempt, per-username for failures only, separate password-change bucket; old shared bucket gone", () => {
    expect(RULES.loginPerUserIp).toEqual({ name: "login:user-ip", limit: 10, windowSeconds: 900 });
    expect(RULES.loginFailuresPerUser).toEqual({ name: "login:user-fail", limit: 30, windowSeconds: 900 });
    expect(RULES.passwordChange.name).toBe("password-change");
    expect(Object.values(RULES).map((r) => r.name)).not.toContain("login:user");
  });
  it("key format unchanged without a qualifier; qualified keys share the subject prefix", () => {
    const k = bucketKey(RULES.passwordReset, "id:x", 1700000000);
    expect(k).toBe(`${subjectPrefix(RULES.passwordReset, "id:x")}1700000000`);
    const q = bucketKey(RULES.loginPerUserIp, "alice", 1700000000, "ip-a");
    expect(q.startsWith(subjectPrefix(RULES.loginPerUserIp, "alice"))).toBe(true);
    expect(q).not.toBe(bucketKey(RULES.loginPerUserIp, "alice", 1700000000, "ip-b"));
  });
  it("an attacker spending one IP's (username, IP) budget doesn't block the same user from another IP", async () => {
    const user = `victim-${Math.random()}`;
    for (let i = 0; i < RULES.loginPerUserIp.limit; i++) await hit(RULES.loginPerUserIp, user, "attacker-ip");
    expect((await hit(RULES.loginPerUserIp, user, "attacker-ip")).allowed).toBe(false);
    expect((await hit(RULES.loginPerUserIp, user, "user-ip")).allowed).toBe(true);
  });
  it("failures ceiling: peek doesn't count; refusal only once failures reach the limit", async () => {
    const user = `u-${Math.random()}`;
    expect(await peek(RULES.loginFailuresPerUser, user)).toBe(0);
    await assertBelowLimit(RULES.loginFailuresPerUser, user);
    expect(await peek(RULES.loginFailuresPerUser, user)).toBe(0);
    for (let i = 0; i < RULES.loginFailuresPerUser.limit; i++) await hit(RULES.loginFailuresPerUser, user);
    await expect(assertBelowLimit(RULES.loginFailuresPerUser, user)).rejects.toBeInstanceOf(RateLimitedError);
  });
  it("resetSubject clears every bucket of the user (all IPs) and nobody else's", async () => {
    const [user, other] = [`a-${Math.random()}`, `b-${Math.random()}`];
    for (const ip of ["ip1", "ip2"]) for (let i = 0; i < 11; i++) await hit(RULES.loginPerUserIp, user, ip);
    for (let i = 0; i < 11; i++) await hit(RULES.loginPerUserIp, other, "ip1");
    await resetSubject(RULES.loginPerUserIp, user);
    expect((await hit(RULES.loginPerUserIp, user, "ip1")).allowed).toBe(true);
    expect((await hit(RULES.loginPerUserIp, user, "ip2")).allowed).toBe(true);
    expect((await hit(RULES.loginPerUserIp, other, "ip1")).allowed).toBe(false);
  });
  it("login and the unlock/reset paths use the new limits (source pinned)", () => {
    const auth = src("src/modules/identity/auth.service.ts");
    expect(auth).toMatch(/enforce\(RULES\.loginPerIp, meta\.ipHash\)/);
    expect(auth).toMatch(/enforce\(RULES\.loginPerUserIp, input\.username, meta\.ipHash\)/);
    expect(auth).toMatch(/assertBelowLimit\(RULES\.loginFailuresPerUser, input\.username\)/);
    expect(auth).not.toMatch(/RULES\.loginPerUser\b/);
    // Every credential failure path records a failure; success does not.
    // (Phase 6A-M3a adds a 4th: a portal account without recorded consent — review M2.)
    expect((auth.match(/return fail\(\);/g) ?? []).length).toBe(4);
    const users = src("src/modules/identity/users.service.ts");
    expect(users.match(/await clearLoginLimits\(username\)/g)?.length).toBe(2); // admin reset + unlock
    expect(src("src/modules/identity/password-reset.service.ts")).toMatch(/await clearLoginLimits\(pre\.user\.username\)/);
    expect(src("src/modules/identity/password.service.ts")).toMatch(/enforce\(RULES\.passwordChange, ctx\.userId\)/);
  });
});

// ───────────────────────────── S-04 ─────────────────────────────
describe("S-04: in-process limiter and negative cache (no database)", () => {
  beforeEach(() => resetLocalLimiterForTests());
  it("hitLocal: allows up to the limit per window, then refuses; a new window starts fresh", () => {
    const rule = { name: "t", limit: 3, windowSeconds: 60 };
    const t0 = 1_700_000_040_000;
    expect([1, 2, 3].map(() => hitLocal(rule, "ip", t0).allowed)).toEqual([true, true, true]);
    expect(hitLocal(rule, "ip", t0).allowed).toBe(false);
    expect(hitLocal(rule, "other-ip", t0).allowed).toBe(true);
    expect(hitLocal(rule, "ip", t0 + 60_000).allowed).toBe(true);
  });
  it("hitLocal memory stays bounded", () => {
    const rule = { name: "b", limit: 1, windowSeconds: 60 };
    for (let i = 0; i < LOCAL_LIMITER_MAX_KEYS + 50; i++) hitLocal(rule, `ip${i}`, 1_700_000_040_000);
    expect(hitLocal(rule, "fresh", 1_700_000_040_000).allowed).toBe(true); // still works when full
  });
  it("TtlSet: expiry, bounded size, re-adding refreshes", () => {
    const set = new TtlSet(1000, 2);
    set.add("a", 0);
    expect(set.has("a", 999)).toBe(true);
    expect(set.has("a", 1000)).toBe(false);
    set.add("x", 0);
    set.add("y", 0);
    set.add("z", 0); // full → oldest dropped
    expect(set.size).toBe(2);
    expect(set.has("x", 1)).toBe(false);
    expect(set.has("z", 1)).toBe(true);
  });
  it("files route: rate limit before any lookup; anonymous requests never touch the session table", () => {
    const route = src("src/app/api/v1/files/[id]/route.ts");
    expect(route.indexOf("hitLocal(RULES.filesPerIp")).toBeLessThan(route.indexOf("readStoredFile(ctx, id)"));
    expect(route).toMatch(/const ctx = hasSession \? await getAuthContext\(\)/);
    expect(route).toMatch(/if \(!file\.publiclyReadable\) return privateFileResponse\(file\)/); // S-10
  });
});

// ───────────────────────────── S-05 / S-06 ─────────────────────────────
describe("S-05 / S-06: test runs write only to an allow-listed, verified target", () => {
  const TEST = { branch: "br-purple-credit-aooeex9m", endpoint: "ep-quiet-brook-aoktw1hh" };
  const DEV = { branch: "br-morning-scene-aoxm8ctk", endpoint: "ep-quiet-river-aoywr8xg" };
  const PROD = { branch: "br-prod-main-a1b2c3d4", endpoint: "ep-prod-host-a1b2c3d4" };
  const url = (ep: string) => `postgresql://u:p@${ep}-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
  const base = {
    TEST_DATABASE_URL: url(TEST.endpoint),
    TEST_TARGET_BRANCH_ID: TEST.branch,
    TEST_TARGET_ENDPOINT_ID: TEST.endpoint,
    FORBIDDEN_BRANCH_IDS: PROD.branch,
    FORBIDDEN_ENDPOINT_IDS: PROD.endpoint,
    SEED_TARGET_BRANCH_ID: DEV.branch,
    SEED_TARGET_ENDPOINT_ID: DEV.endpoint,
  };
  const refuse = (env: Record<string, string>, re: RegExp) => expect(() => resolveRunTarget(env, INTEGRATION_TARGET)).toThrow(re);

  it("accepts the allow-listed Test branch", () => {
    expect(resolveRunTarget(base, INTEGRATION_TARGET)).toMatchObject({ branchId: TEST.branch, endpointId: TEST.endpoint });
  });
  it("refuses: missing allow-list, development, production, URL ≠ allow-list, missing forbidden ids", () => {
    refuse({ ...base, TEST_TARGET_ENDPOINT_ID: "" }, /TEST_TARGET_ENDPOINT_ID is not set/);
    refuse({ ...base, TEST_DATABASE_URL: url(DEV.endpoint), TEST_TARGET_ENDPOINT_ID: DEV.endpoint, TEST_TARGET_BRANCH_ID: DEV.branch }, /DEVELOPMENT/);
    refuse({ ...base, TEST_DATABASE_URL: url(PROD.endpoint) }, /FORBIDDEN endpoint/);
    refuse({ ...base, TEST_TARGET_BRANCH_ID: PROD.branch }, /listed in FORBIDDEN_BRANCH_IDS/);
    refuse({ ...base, TEST_DATABASE_URL: url("ep-other-host-99999999") }, /does not point to TEST_TARGET_ENDPOINT_ID/);
    refuse({ ...base, FORBIDDEN_ENDPOINT_IDS: "" }, /FORBIDDEN_ENDPOINT_IDS is not set/);
    refuse({ ...base, SEED_TARGET_ENDPOINT_ID: "" }, /must be set so it can be refused/);
  });
  it("live identity must equal the allow-list exactly", () => {
    const t = resolveRunTarget(base, INTEGRATION_TARGET);
    expect(() => assertRunIdentity({ branch: TEST.branch, endpoint: TEST.endpoint }, t, INTEGRATION_TARGET)).not.toThrow();
    expect(() => assertRunIdentity({ branch: DEV.branch, endpoint: DEV.endpoint }, t, INTEGRATION_TARGET)).toThrow(TargetGuardError);
    expect(() => assertRunIdentity({ branch: PROD.branch, endpoint: PROD.endpoint }, t, INTEGRATION_TARGET)).toThrow(/FORBIDDEN/);
    expect(() => assertRunIdentity({ branch: null, endpoint: null }, t, INTEGRATION_TARGET)).toThrow(/did not report/);
  });
  it("e2e may target development but still needs its own allow-list and refuses production", () => {
    const e2e = { E2E_DATABASE_URL: url(DEV.endpoint), E2E_TARGET_BRANCH_ID: DEV.branch, E2E_TARGET_ENDPOINT_ID: DEV.endpoint, FORBIDDEN_BRANCH_IDS: PROD.branch, FORBIDDEN_ENDPOINT_IDS: PROD.endpoint };
    expect(resolveRunTarget(e2e, E2E_TARGET).endpointId).toBe(DEV.endpoint);
    expect(() => resolveRunTarget({ ...e2e, E2E_TARGET_BRANCH_ID: "" }, E2E_TARGET)).toThrow(/E2E_TARGET_BRANCH_ID is not set/);
    expect(() => resolveRunTarget({ ...e2e, E2E_DATABASE_URL: url(PROD.endpoint) }, E2E_TARGET)).toThrow(/FORBIDDEN/);
  });
  it("integration globalSetup is wired for integration scope only and refuses shell overrides before reading .env", async () => {
    vi.resetModules();
    vi.stubEnv("npm_lifecycle_event", "test:integration");
    const integ = (await import("../../vitest.config")).default as { test: { globalSetup?: string[] } };
    expect(integ.test.globalSetup).toEqual(["tests/integration-global-setup.ts"]);
    vi.resetModules();
    vi.stubEnv("npm_lifecycle_event", "test:unit");
    const unit = (await import("../../vitest.config")).default as { test: { globalSetup?: string[] } };
    expect(unit.test.globalSetup).toEqual([]);
    vi.unstubAllEnvs();
    vi.stubEnv("TEST_DATABASE_URL", "postgresql://shell-value@127.0.0.1:1/x");
    const { default: setup } = await import("../integration-global-setup");
    await expect(setup()).rejects.toThrow(/set in the shell/);
    vi.unstubAllEnvs();
  });
  it("e2e setup/teardown: guarded, Super Admin lock first, audited, teardown wired", () => {
    const setupSrc = src("tests/e2e/global-setup.ts");
    expect(setupSrc).not.toMatch(/\/prod\/i/);
    expect(setupSrc.indexOf("connectVerified(env)")).toBeLessThan(setupSrc.indexOf('DELETE FROM "user"'));
    expect(setupSrc.indexOf("super_admin_guard")).toBeLessThan(setupSrc.indexOf('DELETE FROM "user"'));
    expect(setupSrc).toMatch(/INSERT INTO audit_log/);
    expect(src("playwright.config.ts")).toMatch(/globalTeardown: "\.\/tests\/e2e\/global-teardown\.ts"/);
    expect(src("tests/e2e/global-teardown.ts")).toMatch(/connectVerified\(env\)/);
  });
});

// ───────────────────────────── S-08 ─────────────────────────────
describe("S-08: role editor offers only scopes the services honour", () => {
  it("every editable role's default grant is within ALLOWED_SCOPES (catalog stays consistent)", () => {
    const bad = ROLES.filter((r) => !r.isSystem).flatMap((r) => r.grants.map(normalizeGrant).filter((g) => !isScopeAllowed(g.key, g.scope)).map((g) => `${r.key}:${g.key}:${g.scope}`));
    expect(bad).toEqual([]);
  });
  it("services without a scope policy are ALL-only; own-record permissions are SELF-only; student.read keeps its scopes", () => {
    for (const k of ["rollnumber.generate", "rollnumber.finalize", "rollnumber.correct", "admission.create", "admission.approve", "academic.manage", "user.manage", "role.manage", "export.run", "student.document.read"] as PermissionKey[]) {
      expect(ALLOWED_SCOPES[k], k).toEqual(["ALL"]);
    }
    expect(ALLOWED_SCOPES["salary.self.read"]).toEqual(["SELF"]);
    expect(ALLOWED_SCOPES["student.read"]).toEqual(["ALL", "ASSIGNED", "CHILDREN", "SELF"]);
    expect(ALLOWED_SCOPES["student.update"]).toEqual(["ALL", "ASSIGNED"]);
  });
  it("assertScopesSupported refuses a NEW unsupported scope but leaves an unchanged older grant alone", () => {
    expect(() => assertScopesSupported([], [{ key: "rollnumber.generate", scope: "ASSIGNED" }])).toThrow(ValidationError);
    expect(() => assertScopesSupported([], [{ key: "student.update", scope: "ASSIGNED" }])).not.toThrow();
    expect(() => assertScopesSupported([{ key: "rollnumber.generate", scope: "ASSIGNED" }], [{ key: "rollnumber.generate", scope: "ASSIGNED" }])).not.toThrow();
    expect(() => assertScopesSupported([{ key: "rollnumber.generate", scope: "ALL" }], [{ key: "rollnumber.generate", scope: "SELF" }])).toThrow(/only be granted for all records/);
  });
  it("the service and the editor use the allow-list", () => {
    expect(src("src/modules/identity/roles.service.ts")).toMatch(/assertScopesSupported\(current, input\.grants\)/);
    expect(src("src/app/erp/roles/[id]/permission-editor.tsx")).toMatch(/\["", \.\.\.r\.allowedScopes\]/);
    expect(src("src/app/erp/roles/[id]/page.tsx")).toMatch(/ALLOWED_SCOPES\[key\]/);
  });
});

// ───────────────────────────── S-09 / S-02 (source pinned; database behaviour in integration) ─────────────
describe("S-09 / S-02: class-teacher assignments end with the role and with the session", () => {
  it("losing every eligible role releases the user's sections in the same transaction (audited)", () => {
    const users = src("src/modules/identity/users.service.ts");
    expect(users).toMatch(/CLASS_TEACHER_ROLE_KEYS as readonly string\[\]\)\.includes\(k\)\)\) \{\s*await releaseClassTeacherAssignments\(tx, actorOf\(ctx\), target\.id\)/);
    const tx = src("src/modules/academic/academic.tx.ts");
    expect(tx).toMatch(/FOR UPDATE/);
    expect(tx).toMatch(/action: "section\.class_teacher_unassign"/);
  });
  it("unassigning is allowed on a CLOSED session; assigning is not", () => {
    const s = src("src/modules/academic/sections.service.ts");
    expect(s).toMatch(/unassignClassTeacher[\s\S]*?lockSectionForWrite\(tx, id, version, \{ allowClosedSession: true \}\)/);
    const assign = s.slice(s.indexOf("export async function assignClassTeacher"), s.indexOf("export async function unassignClassTeacher"));
    expect(assign).toMatch(/lockSectionForWrite\(tx, input\.id, input\.version\)/);
    expect(assign).not.toMatch(/allowClosedSession/);
  });
});

// ───────────────────────────── S-11 ─────────────────────────────
describe("S-11: CSV formula injection — semicolon locales and spreadsheet edge cases", () => {
  it("cells with ; or tab are quoted, so a ;-separated spreadsheet can't split out a formula", () => {
    expect(csvCell('Class 1;=HYPERLINK("http://x","Open")')).toBe('"Class 1;=HYPERLINK(""http://x"",""Open"")"');
    expect(csvCell("a\tb")).toBe('"a\tb"');
    expect(csvCell("a;b")).toBe('"a;b"');
  });
  it("formula starters after leading whitespace / control characters, and full-width forms, are neutralised", () => {
    expect(csvCell("  =1+1")).toBe("'  =1+1"); // prefixed (no longer starts with whitespace, so not quoted)
    expect(csvCell("\u0001=1")).toBe("'\u0001=1");
    for (const v of ["＝1+1", "＋1", "－1", "＠SUM(A1)"]) expect(csvCell(v)).toBe(`'${v}`);
  });
  it("ordinary text is unchanged", () => {
    expect(csvCell("Ananya Das")).toBe("Ananya Das");
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("DEMO-2026-0001")).toBe("DEMO-2026-0001");
  });
});

// ───────────────────────────── S-12 ─────────────────────────────
describe("S-12: roll-number sheet needs student.read ALL (checked before any database access)", () => {
  it("a role with a roll-number permission but no ALL-scope student.read is refused", async () => {
    const { getRollNumberSheet } = await import("@/modules/students/roll-numbers.service");
    // (module instances may differ after vi.resetModules above — compare the error code, not the class)
    await expect(getRollNumberSheet(custom([["rollnumber.generate", "ALL"]]), "sec1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getRollNumberSheet(custom([["rollnumber.generate", "ALL"], ["student.read", "ASSIGNED"]]), "sec1")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("the Principal passes the checks (and only then reaches the database)", async () => {
    const { getRollNumberSheet } = await import("@/modules/students/roll-numbers.service");
    await expect(getRollNumberSheet(ctxFor("PRINCIPAL"), "sec1")).rejects.toThrow(/DATABASE_URL is not set/);
  });
  it("the returned preview carries no date of birth or internal id (source pinned)", () => {
    expect(src("src/modules/students/roll-numbers.service.ts")).toMatch(/const preview = ordered\.map\(\(p\) => \(\{ enrollmentId: p\.enrollmentId, rollNumber: p\.rollNumber, studentCode: p\.studentCode, fullName: p\.fullName \}\)\)/);
  });
});

// ───────────────────────────── S-14 ─────────────────────────────
describe("S-14: no self-approval of admissions", () => {
  it("the creator can't approve; anyone else can; a deleted creator blocks no one", () => {
    expect(() => assertNotSelfApproval("u1", "u1")).toThrow(ForbiddenError);
    expect(() => assertNotSelfApproval("u1", "u1")).toThrow(SELF_APPROVAL_MESSAGE);
    expect(() => assertNotSelfApproval("u1", "u2")).not.toThrow();
    expect(() => assertNotSelfApproval(null, "u2")).not.toThrow();
  });
  it("approval checks it under the application lock; the review page hides the form for the creator", () => {
    expect(src("src/modules/admissions/admissions.service.ts")).toMatch(/assertCanDo\("approve", row\.status\);\s*assertNotSelfApproval\(row\.createdById, ctx\.userId\)/);
    expect(src("src/app/erp/admissions/[id]/page.tsx")).toMatch(/app\.createdBy\?\.id === ctx\.userId \?/);
  });
});

// ───────────────────────────── Export hardening ─────────────────────────────
describe("export hardening", () => {
  it("audit filters never contain the free-text search (only whether one was used, and its length)", () => {
    expect(exportFilterAudit({ academicSessionId: "s1", q: "Ananya Das" })).toEqual({ academicSessionId: "s1", search: { used: true, length: 10 } });
    expect(JSON.stringify(exportFilterAudit({ q: "Ananya Das" }))).not.toContain("Ananya");
    expect(exportFilterAudit({ status: "ACTIVE" })).toEqual({ status: "ACTIVE" });
  });
  it("one query fetches limit + 1 rows and refuses above the limit (no count/fetch race, never truncated)", () => {
    const svc = src("src/modules/students/students.service.ts");
    const fn = svc.slice(svc.indexOf("export async function exportStudentRows"), svc.indexOf("// ───────────────────────────── Photo and documents"));
    expect(fn).toMatch(/take: EXPORT_MAX_ROWS \+ 1/);
    expect(fn).toMatch(/assertExportSize\(rows\.length\)/);
    expect(fn).not.toMatch(/student\.count\(/);
    expect(() => assertExportSize(EXPORT_MAX_ROWS + 1)).toThrow(/More than 5000 students match/);
  });
  it("the export route reads its small body through the capped reader; read errors map to a fixed code", () => {
    expect(src("src/app/api/v1/students/export/route.ts")).toMatch(/readBodyWithLimit\(request\.body, MAX_FORM_BYTES, \{ timeoutMs: 10_000 \}\)/);
    expect(src("src/app/api/v1/students/export/route.ts")).not.toMatch(/request\.text\(\)/);
    expect(exportErrorCode(new RequestTimeoutError())).toBe("invalid");
  });
});
