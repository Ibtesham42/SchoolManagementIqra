import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Phase 6C-M5: two defects found only when the integration suites first ran on the Test branch (2026-11-26). */
const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").split(String.fromCharCode(13)).join("");

describe("6C-M5 regressions", () => {
  it("app code never uses a Prisma `every` relation filter (it did not re-check a to-one relation on Postgres)", () => {
    const svc = read("src", "modules", "notices", "notices.service.ts");
    const body = svc.slice(svc.indexOf("const ownSectionNotices"), svc.indexOf("});", svc.indexOf("const ownSectionNotices")));
    expect(body).not.toMatch(/every:/);
    expect(body).toMatch(/none: \{ OR: \[\{ sectionId: null \}, \{ section: \{ OR: \[\{ classTeacherId: null \}, \{ classTeacherId: \{ not: userId \} \}, \{ academicSession: \{ status: "CLOSED" as const \} \}\] \} \}\] \}/);
  });
  it("the portal fee ledger reaches the student through the invoice's enrollment (FeeInvoice has no `student` relation)", () => {
    const portal = read("src", "modules", "fees", "fees.portal.ts");
    expect(portal).not.toMatch(/feeInvoice\.findMany\(\{\s*(\/\/[^\n]*\n\s*)?where: \{[^}]*student: \{ deletedAt: null \}/);
    expect(portal).toMatch(/enrollment: \{ student: \{ deletedAt: null \} \}/);
  });
});
