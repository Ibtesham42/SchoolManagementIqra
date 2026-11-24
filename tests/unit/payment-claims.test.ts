import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalClaimRef, rejectClaimSchema, submitClaimSchema } from "@/modules/fees/payment-claims.schemas";
import { portalPaymentSettingsSchema } from "@/modules/settings/settings.schemas";
import { notificationTarget } from "@/modules/notifications/notifications.service";
import { RULES } from "@/lib/rate-limit";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";

/** Phase 6C-M3 (P19) — UPI payment intimation, offline: input rules, permissions, locking and leakage guards. */
const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").split(String.fromCharCode(13)).join("");
const fnBody = (src: string, name: string) => {
  const i = src.indexOf(`export async function ${name}(`);
  expect(i, name).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", i + 1);
  return src.slice(i, next < 0 ? undefined : next);
};

describe("claim references", () => {
  it("UPI: exactly 12 digits after removing spaces and punctuation", () => {
    expect(canonicalClaimRef("UPI", "4123 5678 9012")).toBe("412356789012");
    expect(canonicalClaimRef("UPI", "UTR-412356789012")).toBeNull(); // letters
    expect(canonicalClaimRef("UPI", "41235678901")).toBeNull();
    expect(canonicalClaimRef("UPI", "4123567890123")).toBeNull();
  });
  it("bank transfer: 6–30 letters and digits, upper case", () => {
    expect(canonicalClaimRef("BANK_TRANSFER", "sbin-n12345 678")).toBe("SBINN12345678");
    expect(canonicalClaimRef("BANK_TRANSFER", "ab12")).toBeNull();
    expect(canonicalClaimRef("BANK_TRANSFER", "A".repeat(31))).toBeNull();
  });
  it("the canonical claim reference survives the counter's own normalisation unchanged (one uniqueness key)", async () => {
    const { normalizeReferenceFor } = await import("@/modules/fees/fee-rules");
    for (const [m, raw] of [["UPI", "4123 5678 9012"], ["BANK_TRANSFER", "sbin-n12345 678"]] as const) {
      const c = canonicalClaimRef(m, raw)!;
      expect(normalizeReferenceFor(m, c)).toBe(c);
    }
  });
});

describe("schemas", () => {
  const ok = { studentId: "s1", amount: "1500", method: "UPI", transactionRef: "412356789012", paidOn: "2026-11-24" };
  it("submit: strict, positive money as a string, UPI / bank transfer only", () => {
    expect(submitClaimSchema.safeParse(ok).success).toBe(true);
    for (const bad of [{ amount: "0" }, { amount: "-5" }, { amount: "15.555" }, { amount: "1e3" }, { method: "CASH" }, { method: "CARD" }, { paidOn: "2026-02-30" }, { extra: 1 }]) {
      expect(submitClaimSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("reject: a reason of 3–300 characters, no control characters", () => {
    expect(rejectClaimSchema.safeParse({ id: "c1", version: "1", reason: "Not on statement" }).success).toBe(true);
    expect(rejectClaimSchema.safeParse({ id: "c1", version: "1", reason: "no" }).success).toBe(false);
    expect(rejectClaimSchema.safeParse({ id: "c1", version: "1", reason: "a\u0000bc" }).success).toBe(false);
  });
  it("review L2 / M1: claim keys never match the counter's key pattern; receipts match a claim by suffix", async () => {
    const { collectSchema } = await import("@/modules/fees/collection.schemas");
    const shape = collectSchema.safeParse({ studentId: "s1", amount: "1", method: "CASH", transactionRef: null, bankName: null, instrumentDate: null, paidOn: "2026-11-24", idempotencyKey: "claim:cabcdefghijklmnopqrstuvw" });
    expect(shape.success).toBe(false);
    const { liveReceiptRefWhere } = await import("@/modules/fees/payment-claims.schemas");
    expect(liveReceiptRefWhere("412356789012")).toEqual({ status: "SUCCESS", method: { in: ["UPI", "BANK_TRANSFER"] }, transactionRef: { endsWith: "412356789012" } });
  });
  it("review L4: no control or direction-override characters in the payee name", () => {
    for (const bad of ["Demo\u202Ekcab", "Demo\u200BSchool", "Demo\u0007"]) expect(portalPaymentSettingsSchema.safeParse({ payeeName: bad, vpa: "demo@bank", leaverAccessDays: "1" }).success, bad).toBe(false);
  });
  it("portal settings: UPI payee and ID both or neither; a real UPI ID; leaver days 0–365", () => {
    expect(portalPaymentSettingsSchema.safeParse({ payeeName: "Demo Public School", vpa: "demo.school@bank", leaverAccessDays: "180" }).success).toBe(true);
    expect(portalPaymentSettingsSchema.safeParse({ payeeName: "", vpa: "", leaverAccessDays: "0" }).success).toBe(true);
    expect(portalPaymentSettingsSchema.safeParse({ payeeName: "Demo", vpa: "", leaverAccessDays: "180" }).success).toBe(false);
    expect(portalPaymentSettingsSchema.safeParse({ payeeName: "", vpa: "demo@bank", leaverAccessDays: "180" }).success).toBe(false);
    expect(portalPaymentSettingsSchema.safeParse({ payeeName: "Demo", vpa: "not-a-upi-id", leaverAccessDays: "180" }).success).toBe(false);
    expect(portalPaymentSettingsSchema.safeParse({ payeeName: "Demo", vpa: "demo@bank", leaverAccessDays: "400" }).success).toBe(false);
  });
});

describe("permissions and limits", () => {
  const grants = (key: string) => ROLES.find((r) => r.key === key)!.grants.map(normalizeGrant);
  it("only parents (CHILDREN) may submit; students never; the Accountant decides with fee.collect ALL", () => {
    expect(grants("PARENT")).toContainEqual({ key: "fee.pay.online", scope: "CHILDREN" });
    expect(grants("STUDENT").some((g) => g.key === "fee.pay.online")).toBe(false);
    expect(grants("ACCOUNTANT")).toContainEqual({ key: "fee.collect", scope: "ALL" });
  });
  it("5 claims a day per account", () => {
    expect(RULES.paymentClaim).toEqual({ name: "payment-claim", limit: 5, windowSeconds: 86_400 });
  });
  it("claim notifications are per-student fee rows (hidden by the inbox filter after a block)", () => {
    expect(notificationTarget("claim:s1:c1")).toEqual({ kind: "student", studentId: "s1", capability: "fees" });
  });
});

describe("static guards", () => {
  const portal = read("src", "modules", "fees", "payment-claims.portal.ts");
  const svc = read("src", "modules", "fees", "payment-claims.service.ts");
  it("portal reads: the child check and the claim permission come before any read; parents never see the office side", () => {
    for (const fn of ["getPortalPayPage", "submitPortalClaim"]) {
      const body = fnBody(portal, fn);
      const check = body.indexOf("assertClaimant(ctx);");
      expect(body.indexOf("assertPortalStudent(")).toBeLessThan(check);
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(body.search(/prisma\.|openInvoicesOf\(|enforce\(/));
    }
    expect(portal).toMatch(/ctx\.portal\.kind !== "GUARDIAN" \|\| portalScopeOf\(ctx\)\("fee\.pay\.online"\) !== "CHILDREN"/);
    expect(portal).not.toMatch(/rejectReason|decidedBy|decidedAt|submittedBy: \{/);
    expect(portal).toMatch(/refEnd: c\.transactionRef\.slice\(-4\)/);
    // Review L1: no claims while the school has no UPI details; review M1: suffix match at submit too.
    expect(fnBody(portal, "submitPortalClaim")).toMatch(/if \(!\(await getPortalSettings\(\)\)\.upi\) throw/);
    expect(fnBody(portal, "submitPortalClaim")).toMatch(/findFirst\(\{ where: liveReceiptRefWhere\(ref\)/);
  });
  it("audit rows never carry the amount, the reference or the reason", () => {
    for (const src of [portal, svc]) {
      for (const m of src.matchAll(/await audit\(tx, actorOf\(ctx\), \{([\s\S]*?)\}\);/g)) expect(m[1]).not.toMatch(/amount|transactionRef|\bref\b|reason/);
    }
  });
  it("confirm: student lock → claim row FOR UPDATE → the counter's collectInTx, all in one transaction; families told after commit", () => {
    const body = fnBody(svc, "confirmPaymentClaim");
    const tx = body.indexOf("prisma.$transaction(");
    const lock = body.indexOf("await lockFeeStudent(tx, peek.studentId)");
    const row = body.indexOf("FROM fee_payment_claim WHERE id = ${input.id} FOR UPDATE");
    const collect = body.indexOf("await collectInTx(tx, ctx, collect, prep)");
    const update = body.indexOf('status: "CONFIRMED", paymentId: r.id');
    expect(tx).toBeGreaterThan(-1);
    expect(tx).toBeLessThan(lock);
    expect(lock).toBeLessThan(row);
    expect(row).toBeLessThan(collect);
    expect(collect).toBeLessThan(update);
    expect(body.indexOf("await afterCommit(")).toBeGreaterThan(body.indexOf("} catch (e) {"));
    expect(body).toMatch(/idempotencyKey: `claim:\$\{input\.id\}`/); // review L2: the counter's key pattern has no ':'
    // Review M1: under the lock and before the collection, a live receipt with this reference in any counter form refuses.
    const dup = body.indexOf("liveReceiptRefWhere(peek.transactionRef)");
    expect(dup).toBeGreaterThan(row);
    expect(dup).toBeLessThan(collect);
    expect(body).toMatch(/peek\.submittedById === ctx\.userId\) throw new ForbiddenError/);
  });
  it("reject: row FOR UPDATE, submitter can't decide, families told after commit", () => {
    const body = fnBody(svc, "rejectPaymentClaim");
    expect(body).toMatch(/FOR UPDATE/);
    expect(body).toMatch(/row\.submitted_by_id === ctx\.userId\) throw new ForbiddenError/);
    expect(body.indexOf("await afterCommit(")).toBeGreaterThan(body.indexOf("} catch (e) {"));
  });
  it("review M1b: UPI references compare by their trailing 12-digit UTR at the counter too", async () => {
    const { upiTail } = await import("@/modules/fees/collection.service");
    expect(upiTail("UTR412356789012")).toBe("412356789012");
    expect(upiTail("412356789012")).toBe("412356789012");
    expect(upiTail("UPI41235678901")).toBeNull();
    const collection = read("src", "modules", "fees", "collection.service.ts");
    const body = fnBody(collection, "collectInTx");
    expect(body.indexOf("transactionRef: { endsWith: utr }")).toBeGreaterThan(body.indexOf("await lockFeeStudent(tx, input.studentId)"));
  });
  it("the counter and claim confirmation share one collection path", () => {
    const collection = read("src", "modules", "fees", "collection.service.ts");
    expect(fnBody(collection, "collectPayment")).toMatch(/prisma\.\$transaction\(\(tx\) => collectInTx\(tx, ctx, input, prep\)/);
  });
});
