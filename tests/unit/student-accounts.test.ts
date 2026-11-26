import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { studentAccountActiveSchema, studentSlipSchema } from "@/modules/students/family-accounts.schemas";
import { portalPaymentSettingsSchema, readPortalSettings } from "@/modules/settings/settings.schemas";
import { portalCanSee } from "@/lib/rbac/portal-scope";

/** Phase 6C-M4 (P14, P16, P17) — student accounts, offline: inputs, defaults, the no-fees rule, leaver wiring. */
const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").split(String.fromCharCode(13)).join("");
const fnBody = (src: string, name: string) => {
  const i = src.indexOf(`export async function ${name}(`);
  expect(i, name).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", i + 1);
  return src.slice(i, next < 0 ? undefined : next);
};

describe("inputs and defaults", () => {
  it("slip and active schemas are strict", () => {
    expect(studentSlipSchema.safeParse({ studentId: "s1", mode: "create", username: "" }).success).toBe(true);
    expect(studentSlipSchema.safeParse({ studentId: "s1", mode: "create", username: "Demo-2026-0001" }).data?.username).toBe("demo-2026-0001");
    expect(studentSlipSchema.safeParse({ studentId: "s1", mode: "create", guardianId: "g1" }).success).toBe(false);
    expect(studentAccountActiveSchema.safeParse({ studentId: "s1", active: false, reason: "no" }).success).toBe(false);
  });
  it("student accounts are OFF by default, from Class 9; the office form bounds the class level", () => {
    expect(readPortalSettings(null)).toMatchObject({ studentAccounts: false, studentMinClassLevel: 9 });
    const ok = { payeeName: "", vpa: "", leaverAccessDays: "180", studentAccounts: true, studentMinClassLevel: "9" };
    expect(portalPaymentSettingsSchema.safeParse(ok).success).toBe(true);
    for (const lvl of ["0", "13", "8.5"]) expect(portalPaymentSettingsSchema.safeParse({ ...ok, studentMinClassLevel: lvl }).success, lvl).toBe(false);
  });
  it("a student account never sees fees, even with fee.read SELF granted by an edited role (P16)", () => {
    const family = { kind: "STUDENT" as const, children: [{ studentId: "s1", status: "ACTIVE" as const, leftOn: null, portalAccess: true }] };
    expect(portalCanSee(family, () => "SELF", "s1", "fees", { today: "2026-11-24", leaverAccessDays: 180 })).toBe(false);
    expect(portalCanSee(family, () => "SELF", "s1", "results", { today: "2026-11-24", leaverAccessDays: 180 })).toBe(true);
    expect(portalCanSee(family, () => "SELF", "s2", "results", { today: "2026-11-24", leaverAccessDays: 180 })).toBe(false);
  });
});

describe("static guards", () => {
  const svc = read("src", "modules", "students", "family-accounts.service.ts");
  it("eligibility is re-checked under the student lock for new AND reset slips, and before reactivation", () => {
    const issue = fnBody(svc, "issueStudentSlip");
    expect(issue.indexOf("await lockStudents(tx, [input.studentId])")).toBeLessThan(issue.indexOf("await studentAccountProblemTx(tx, input.studentId, settings)"));
    expect(issue.indexOf("await studentAccountProblemTx(tx")).toBeLessThan(issue.indexOf('if (input.mode === "create")'));
    expect(issue).toMatch(/kind: "STUDENT"/);
    const active = fnBody(svc, "setStudentAccountActive");
    expect(active).toMatch(/if \(input\.active\) \{\s*const problem = await studentAccountProblemTx\(tx/);
  });
  it("eligibility needs the setting, a studying student at the minimum class, and an ACTIVATED parent who may see the child", () => {
    const i = svc.indexOf("async function studentAccountProblemTx(");
    const body = svc.slice(i, svc.indexOf("\n}\n", i));
    expect(body).toMatch(/if \(!settings\.studentAccounts\)/);
    expect(body).toMatch(/level < settings\.studentMinClassLevel/);
    expect(body).toMatch(/portalAccess: true, guardian: \{ deletedAt: null, account: \{ is: \{ isActive: true, deletedAt: null, privacyConsentAt: \{ not: null \} \} \} \}/);
  });
  it("leaving deactivates the student's account inside the leaving transaction (status change and promotion)", () => {
    const status = fnBody(read("src", "modules", "students", "students.service.ts"), "changeStudentStatus");
    const tx = status.indexOf("prisma.$transaction(");
    const upd = status.indexOf("data: { status: input.toStatus, version: { increment: 1 } }");
    const off = status.indexOf("await deactivateStudentAccountOnLeavingTx(tx, actorOf(ctx), row.id)");
    expect(tx).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(tx);
    expect(off).toBeGreaterThan(upd);
    expect(read("src", "modules", "students", "promotion.service.ts")).toMatch(/if \(d\.decision === "LEAVE"\) \{[\s\S]*?await deactivateStudentAccountOnLeavingTx\(tx, actorOf\(ctx\), e\.studentId\);/);
  });
  it("review L1: the student's portal guardians are locked after the student and before the eligibility read", () => {
    for (const name of ["issueStudentSlip", "setStudentAccountActive"]) {
      const body = fnBody(svc, name);
      const student = body.indexOf("await lockStudents(tx, [input.studentId])");
      const guardians = body.indexOf("lockStudentGuardiansTx(tx, input.studentId)");
      expect(student, name).toBeGreaterThan(-1);
      expect(guardians, name).toBeGreaterThan(student);
      expect(body.indexOf("await studentAccountProblemTx(tx"), name).toBeGreaterThan(guardians);
    }
  });
  it("review M1: narrowing the setting switches off ineligible student accounts inside the settings transaction", () => {
    const body = fnBody(read("src", "modules", "settings", "settings.service.ts"), "updatePortalPaymentSettings");
    const lock = body.indexOf("FOR UPDATE");
    const sweep = body.indexOf("deactivateIneligibleStudentAccountsTx(tx, actorOf(ctx), next)");
    expect(lock).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(lock);
    expect(sweep).toBeLessThan(body.indexOf("invalidateSchoolProfileCache()"));
    expect(body).toMatch(/\(before\.studentAccounts && !next\.studentAccounts\) \|\| \(next\.studentAccounts && next\.studentMinClassLevel > before\.studentMinClassLevel\)/);
  });
  it("review M1: blocking or switching off a parent re-checks the children's own accounts in the same transaction", () => {
    const block = fnBody(svc, "setGuardianPortalAccess");
    expect(block.indexOf("deactivateOrphanedStudentAccountsTx(tx, actorOf(ctx), [input.studentId])")).toBeGreaterThan(block.indexOf("tx.studentGuardian.update("));
    const off = fnBody(svc, "setFamilyAccountActive");
    expect(off).toMatch(/if \(changed && !input\.active\) \{[\s\S]*?await deactivateOrphanedStudentAccountsTx\(tx, actorOf\(ctx\), children\.map/);
  });
  it("review M1: the sweeps lock the student account before reading parents, touch only student accounts, and end sessions and codes", () => {
    const sweep = read("src", "modules", "students", "student-accounts.tx.ts");
    const orphan = fnBody(sweep, "deactivateOrphanedStudentAccountsTx");
    expect(orphan.indexOf("FOR UPDATE")).toBeGreaterThan(-1);
    expect(orphan.indexOf("FOR UPDATE")).toBeLessThan(orphan.indexOf("tx.studentGuardian.findMany("));
    expect(orphan).toMatch(/privacyConsentAt: \{ not: null \}/);
    const bulk = fnBody(read("src", "modules", "identity", "portal-accounts.tx.ts"), "deactivateStudentPortalAccountsTx");
    expect(bulk).toMatch(/student_id IS NOT NULL AND guardian_id IS NULL AND employee_id IS NULL/);
    expect(bulk).toMatch(/ORDER BY id FOR UPDATE/);
    expect(bulk).toMatch(/tx\.session\.deleteMany/);
    expect(bulk).toMatch(/tx\.accountActivation\.updateMany\(\{ where: \{ userId: \{ in: ids \}, usedAt: null \}/);
    expect(bulk).toMatch(/auditMany\(/);
  });
  it("re-check L-A / L-C / L-D: settings read FOR SHARE, sweep refuses past its bound, merges re-check the children", () => {
    const settingsSvc = read("src", "modules", "settings", "settings.service.ts");
    expect(fnBody(settingsSvc, "readPortalSettingsTx")).toMatch(/FROM school_setting WHERE id = \$\{SETTINGS_ID\} FOR SHARE/);
    const sweep = fnBody(read("src", "modules", "students", "student-accounts.tx.ts"), "deactivateIneligibleStudentAccountsTx");
    expect(sweep).toMatch(/if \(accounts\.length === MAX_SWEEP\) throw new ConflictError/);
    expect(fnBody(svc, "setFamilyAccountActive")).toMatch(/student: \{ deletedAt: null, account: \{ is: \{ isActive: true, deletedAt: null \} \} \}/);
    const merge = read("src", "modules", "students", "guardian-links.service.ts");
    expect(merge).toMatch(/action: "guardian\.merge"[\s\S]*?await deactivateOrphanedStudentAccountsTx\(tx, actorOf\(ctx\), \[\.\.\.lockedStudents\]\)/);
  });
  it("the slip route accepts target=student and returns to the student's page built from a validated id", () => {
    const route = read("src", "app", "api", "v1", "portal-accounts", "slips", "route.ts");
    expect(route).toMatch(/\} else if \(target === "student"\) \{\s*const parsed = studentSlipSchema\.safeParse/);
    expect(route).toMatch(/\(target === "guardian" \|\| target === "student"\) && ID_RE\.test\(studentId\)/);
  });
});
