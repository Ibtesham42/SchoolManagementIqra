import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { RULES } from "@/lib/rate-limit";
import { canReadFeeReports } from "@/modules/fees/fees.policy";
import { gapLabel } from "@/modules/fees/report-rows";
import { runReconciliation } from "@/modules/fees/reconciliation.service";

/** Phase 5C-M2 reconciliation: gap labels, who may run it, and the design guards (bounded, no personal data). */

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("numbering gaps (pure)", () => {
  it("labels one missing number or a run, with the series' zero padding", () => {
    expect(gapLabel({ prefix: "RCT/2026/", from: 42, to: 42, width: 5 })).toBe("RCT/2026/00042");
    expect(gapLabel({ prefix: "INV-", from: 7, to: 9, width: 3 })).toBe("INV-007 – INV-009 (3 missing)");
    expect(gapLabel({ prefix: "R", from: 100, to: 100, width: 2 })).toBe("R100");
  });
});

describe("who runs reconciliation", () => {
  it("fee.report at ALL; every other role is refused before the database", async () => {
    for (const role of ROLES) {
      const ctx = roleCtx(role.key);
      if (!canReadFeeReports(ctx)) await expect(runReconciliation(ctx), role.key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("design guards", () => {
  const svc = readFileSync(new URL("../../src/modules/fees/reconciliation.service.ts", import.meta.url), "utf8");
  it("every sample query is bounded and returns receipt / invoice numbers only", () => {
    const samples = svc.match(/AS s FROM[\s\S]*?`/g) ?? [];
    expect(samples.length).toBe(5);
    for (const q of samples) expect(q).toContain("LIMIT ${SAMPLES}");
    expect(svc).not.toMatch(/full_name|display_name|transaction_ref|cancel_reason|phone/);
    expect(svc.match(/LIMIT \$\{SAMPLES\}/g)?.length).toBe(7);
  });
  it("the action is rate limited before the service runs", () => {
    expect(RULES.feeReconciliation.limit).toBeGreaterThan(0);
    const actions = readFileSync(new URL("../../src/app/erp/fees/actions.ts", import.meta.url), "utf8");
    const fn = actions.slice(actions.indexOf("export async function runReconciliationAction"));
    expect(fn.indexOf("enforce(RULES.feeReconciliation")).toBeLessThan(fn.indexOf("runReconciliation(ctx)"));
  });
});
