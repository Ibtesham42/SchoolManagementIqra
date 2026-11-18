import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGACY_PURPOSE, UPLOAD_RULES } from "@/lib/storage/upload-rules";

/**
 * Offline review guard for migration 20261109000000 (no database). Pins the safety properties the
 * owner approved, so a later edit can't silently weaken them. Executing the SQL is an integration
 * concern (pending the Neon test branch).
 */
const sql = readFileSync(new URL("../../prisma/migrations/20261109000000_phase2a_files_documents_settings/migration.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const pos = (needle: string) => {
  const i = code.indexOf(needle);
  expect(i, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe("migration 20261109000000 (static review)", () => {
  it("runs in one transaction and is expand-only (no DROP, no TRUNCATE, no DELETE)", () => {
    expect(code.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(code.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  });

  it("checks existing data before changing anything, and aborts on unencrypted private files", () => {
    const guard = pos("DO $$");
    for (const change of ["CREATE TYPE", "ALTER TABLE", "UPDATE "]) expect(guard).toBeLessThan(pos(change));
    expect(code).toMatch(/"visibility" = 'PRIVATE' AND \("encrypted" = false OR "key_version" IS NULL\)/);
    expect(code).toMatch(/RAISE EXCEPTION 'Migration 20261109000000 aborted: % PRIVATE/);
    // Every value copied into owner_id VARCHAR(64) is length-checked first (both backfill sources).
    expect(code).toContain(`FROM "stored_file" WHERE length("id") > 64`);
    expect(code).toContain(`FROM "school_setting" WHERE "logo_file_id" IS NOT NULL AND length("id") > 64`);
    expect(code).toContain(`"owner_id" VARCHAR(64)`);
  });

  it("backfills purpose before NOT NULL and gives legacy files the LegacyFile sentinel owner", () => {
    const logo = pos(`SET "purpose" = 'school.logo', "owner_type" = 'SchoolSetting'`);
    const legacy = pos(`SET "purpose" = '${LEGACY_PURPOSE}', "owner_type" = 'LegacyFile', "owner_id" = "id"`);
    const notNull = pos(`ALTER COLUMN "purpose" SET NOT NULL`);
    expect(logo).toBeLessThan(legacy);
    expect(legacy).toBeLessThan(notNull);
    // Backfilled values must agree with the application's rules.
    expect(UPLOAD_RULES["school.logo"].ownerType).toBe("SchoolSetting");
    expect(Object.values(UPLOAD_RULES).map((r) => r.ownerType)).not.toContain("LegacyFile");
    expect(Object.keys(UPLOAD_RULES)).not.toContain(LEGACY_PURPOSE);
  });

  it("adds every approved CHECK as a fully validated constraint, after the backfills", () => {
    expect(code).not.toMatch(/NOT VALID/i);
    const legacy = pos("'LegacyFile'");
    for (const name of ["stored_file_owner_pair", "stored_file_private_has_owner", "stored_file_private_encrypted"]) {
      expect(pos(`"${name}"`)).toBeGreaterThan(legacy);
    }
    expect(code).toContain(`CHECK ("visibility" = 'PUBLIC' OR ("owner_type" IS NOT NULL AND "owner_id" IS NOT NULL))`);
    expect(code).toContain(`CHECK ("visibility" = 'PUBLIC' OR ("encrypted" = true AND "key_version" IS NOT NULL))`);
    for (const name of ["generated_document_code_hash_format", "generated_document_key_version_positive", "generated_document_revocation_consistent"]) {
      expect(code).toContain(`"${name}" CHECK`);
    }
  });

  it("stores verification hashes with a mandatory key version and no default", () => {
    expect(code).toContain(`"verification_code_hash" CHAR(64) NOT NULL`);
    expect(code).toMatch(/"verification_key_version" SMALLINT NOT NULL,/); // no DEFAULT
    expect(schema).toMatch(/verificationKeyVersion\s+Int\s+@map\("verification_key_version"\) @db\.SmallInt/);
    expect(code).toContain(`CHECK ("verification_code_hash" ~ '^[0-9a-f]{64}$')`);
  });

  it("clears dangling logo references before adding the SET NULL foreign key; PDFs are RESTRICT", () => {
    expect(pos(`UPDATE "school_setting" SET "logo_file_id" = NULL`)).toBeLessThan(pos(`"school_setting_logo_file_id_fkey"`));
    expect(code).toMatch(/"school_setting_logo_file_id_fkey" FOREIGN KEY \("logo_file_id"\) REFERENCES "stored_file"\("id"\) ON DELETE SET NULL/);
    expect(code).toMatch(/"generated_document_file_id_fkey" FOREIGN KEY \("file_id"\) REFERENCES "stored_file"\("id"\) ON DELETE RESTRICT/);
  });

  it("single-school installation (ADR-030): no school_id columns", () => {
    expect(code).not.toMatch(/school_id/i);
    expect(schema).not.toMatch(/\bschoolId\b/);
  });
});
