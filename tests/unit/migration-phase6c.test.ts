import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Offline review guard for migration 20261127000000 (Phase 6C-M1, PHASE_6_PLAN.md §5 migration B). */
const sql = readFileSync(new URL("../../prisma/migrations/20261127000000_phase6c_notices/migration.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("migration 20261127000000 (static review)", () => {
  it("one transaction with a lock timeout; marked for review", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toMatch(/Review status: (DRAFT — awaiting the owner's SQL approval|SQL approved by the owner \d{4}-\d{2}-\d{2})\./);
  });
  it("expand-only: no existing table altered except by new foreign keys pointing at it; no data written", () => {
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+"|\bINSERT\b|ALTER COLUMN|ADD COLUMN|NOT VALID|CONCURRENTLY/i);
    const altered = new Set([...code.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]));
    expect([...altered].sort()).toEqual(["notice", "notice_read", "notice_target"]);
  });
  it("three new tables and three enums; no SCHEDULED status (a future publish_at is scheduled)", () => {
    expect([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1])).toEqual(["notice", "notice_target", "notice_read"]);
    expect(code).toContain(`CREATE TYPE "NoticeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');`);
    expect(code).toContain(`CREATE TYPE "NoticeAudience" AS ENUM ('FAMILIES', 'STAFF', 'ALL');`);
    expect(code).toContain(`CREATE TYPE "NoticeScope" AS ENUM ('SCHOOL', 'CLASS', 'SECTION');`);
  });
  it("targets stay inside the notice's session and scope; attachments are unique and never deleted under a notice", () => {
    expect(code).toContain(`FOREIGN KEY ("notice_id", "academic_session_id", "scope") REFERENCES "notice"("id", "academic_session_id", "scope") ON DELETE CASCADE ON UPDATE CASCADE`);
    expect(code).toContain(`FOREIGN KEY ("section_id", "academic_session_id") REFERENCES "section"("id", "academic_session_id") ON DELETE RESTRICT`);
    expect(code).toContain(`CREATE UNIQUE INDEX "notice_attachment_file_id_key" ON "notice"("attachment_file_id");`);
    expect(code).toContain(`FOREIGN KEY ("attachment_file_id") REFERENCES "stored_file"("id") ON DELETE RESTRICT`);
    expect(code).toContain(`CONSTRAINT "notice_read_pkey" PRIMARY KEY ("notice_id","user_id")`);
  });
  it("seven hand-written CHECKs", () => {
    expect([...code.matchAll(/ADD CONSTRAINT "([a-z_]+)" CHECK/g)].map((m) => m[1]).sort()).toEqual(
      ["notice_expiry", "notice_published", "notice_staff_school_wide", "notice_target_kind", "notice_text", "notice_version", "notice_withdrawn"].sort(),
    );
    expect(code).toContain(`CHECK ("audience" = 'FAMILIES' OR "scope" = 'SCHOOL')`);
  });
});
