/**
 * Database verification: `npm run db:check`
 * Confirms connectivity on both URLs, server version, pgvector, applied migrations,
 * that every Prisma model's table exists, row counts, and Neon free-tier storage use.
 * Prints no secrets (hosts are shown, credentials are not).
 */
import "dotenv/config";
import pg from "pg";
import { APP_TABLES_IN_FK_ORDER } from "./db-tables";

const FREE_STORAGE_BYTES = 0.5 * 1024 ** 3; // conservative: Neon Free is 0.5–1 GB/project; warn early
const EXPECTED_TABLES: readonly string[] = APP_TABLES_IN_FK_ORDER;

/** Phase 2a CHECK constraints (migration 20261109000000) — must exist and be fully validated. */
const EXPECTED_CHECKS = [
  ["stored_file", "stored_file_owner_pair"],
  ["stored_file", "stored_file_private_has_owner"],
  ["stored_file", "stored_file_private_encrypted"],
  ["generated_document", "generated_document_code_hash_format"],
  ["generated_document", "generated_document_key_version_positive"],
  ["generated_document", "generated_document_revocation_consistent"],
] as const;

/** Phase 2a foreign keys and their ON DELETE rule (pg_constraint.confdeltype: n = SET NULL, r = RESTRICT). */
const EXPECTED_FKS = [
  ["school_setting_logo_file_id_fkey", "n"],
  ["generated_document_file_id_fkey", "r"],
  ["generated_document_generated_by_id_fkey", "n"],
  ["generated_document_revoked_by_id_fkey", "n"],
] as const;

/** Phase 2 classes & sections (migration 20261110000000): CHECKs, RESTRICT foreign keys, partial unique index. */
const CLASS_SECTION_CHECKS = [
  ["school_setting", "school_setting_default_section_capacity_check"],
  ["school_class", "school_class_code_format_check"],
  ["school_class", "school_class_name_normalized_check"],
  ["school_class", "school_class_name_key_check"],
  ["school_class", "school_class_numeric_level_check"],
  ["school_class", "school_class_display_order_check"],
  ["school_class", "school_class_default_section_capacity_check"],
  ["school_class", "school_class_version_check"],
  ["section", "section_name_normalized_check"],
  ["section", "section_name_key_check"],
  ["section", "section_code_format_check"],
  ["section", "section_capacity_check"],
  ["section", "section_version_check"],
] as const;
const CLASS_SECTION_FKS = [
  ["section_academic_session_id_fkey", "r"],
  ["section_class_id_fkey", "r"],
  ["section_class_teacher_id_fkey", "r"],
] as const;
const CLASS_TEACHER_INDEX = "section_session_class_teacher_key";

/** Phase 3A HR core (migration 20261112000000): 21 CHECKs, 12 foreign keys with their ON DELETE rule, photo index. */
/** Phase 3B migration 20261119000000 (tests/unit/migration-phase3b.test.ts pins the same number). */
const PHASE_3B_CHECK_COUNT = 20;
/** Phase 3C migration 20261120000000 (tests/unit/migration-phase3c.test.ts pins the same numbers). */
const PHASE_3C_CHECK_COUNT = 28;
const PHASE_3C_TABLES = ["salary_component", "salary_structure", "salary_structure_item", "employee_salary", "payroll_run", "payroll_slip", "payroll_adjustment", "salary_payment"];
/** Phase 4A migration 20261121000000 (tests/unit/migration-phase4a.test.ts pins the same numbers). */
const PHASE_4A_CHECK_COUNT = 16;
const PHASE_4A_TABLES = ["subject", "class_subject", "student_subject", "teacher_allocation", "period", "timetable_slot", "student_attendance"];
/** Phase 4B migration 20261122000000 (tests/unit/migration-phase4b.test.ts pins the same number). */
const PHASE_4B_CHECK_COUNT = 26;
const PHASE_4B_TABLES = ["grade_scale", "grade_band", "examination", "exam_subject", "marks_sheet", "examination_marks", "report_card"];
/** Phase 4C migration 20261123000000 (tests/unit/migration-phase4c.test.ts pins the same number). */
const PHASE_4C_CHECK_COUNT = 11;
const PHASE_4C_TABLES = ["promotion_decision", "homework", "academic_event"];
const PHASE_3C_PARTIAL_INDEXES = ["employee_salary_one_pending_key", "employee_salary_one_approved_per_month_key", "salary_payment_method_reference_key"];

const HR_CHECKS = [
  ...["department", "designation"].flatMap((t) => [`${t}_code_format_check`, `${t}_name_shape_check`, `${t}_name_key_shape_check`, `${t}_version_check`]),
  ...["version", "code", "name", "phone", "dob", "dates", "leaving", "reports_to"].map((c) => `employee_${c}_check`),
  ...["version", "experience", "specializations", "qualifications"].map((c) => `teacher_profile_${c}_check`),
  "employee_document_label_check",
] as const;
const HR_FKS = [
  ["user_employee_id_fkey", "r"],
  ["employee_department_id_fkey", "r"],
  ["employee_designation_id_fkey", "r"],
  ["employee_reports_to_id_fkey", "r"],
  ["employee_created_by_id_fkey", "n"],
  ["teacher_profile_employee_id_fkey", "r"],
  ["employee_document_employee_id_fkey", "r"],
  ["employee_document_file_id_fkey", "r"],
  ["employee_document_uploaded_by_id_fkey", "n"],
  ["employee_document_verified_by_id_fkey", "n"],
  ["employee_service_event_employee_id_fkey", "r"],
  ["employee_service_event_acted_by_id_fkey", "n"],
] as const;
const EMPLOYEE_PHOTO_INDEX = "employee_document_employee_photo_key";

function describe(url: string | undefined): string {
  if (!url) return "(not set)";
  try {
    const u = new URL(url);
    return `${u.hostname}/${u.pathname.slice(1)} (pooled=${u.hostname.includes("-pooler")})`;
  } catch {
    return "(unparseable URL)";
  }
}

async function check(label: string, url: string | undefined) {
  if (!url) {
    console.log(`✗ ${label}: not set`);
    return false;
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ v: string }>("select current_setting('server_version') as v");
    console.log(`✓ ${label}: connected to ${describe(url)} — PostgreSQL ${rows[0].v}`);
    return true;
  } catch (e) {
    console.log(`✗ ${label}: ${describe(url)} — ${(e as Error).message}`);
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const pooledOk = await check("DATABASE_URL (runtime, pooled)", process.env.DATABASE_URL);
  const directOk = await check("DIRECT_URL (migrations, direct)", process.env.DIRECT_URL);
  if (!pooledOk || !directOk) {
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  try {
    const ext = await client.query<{ extversion: string }>("select extversion from pg_extension where extname = 'vector'");
    console.log(ext.rowCount ? `✓ pgvector ${ext.rows[0].extversion} enabled` : "✗ pgvector NOT enabled");

    const mig = await client
      .query<{ migration_name: string; finished_at: Date | null }>(
        "select migration_name, finished_at from _prisma_migrations order by started_at",
      )
      .catch(() => ({ rows: [] as { migration_name: string; finished_at: Date | null }[] }));
    console.log(`✓ migrations applied: ${mig.rows.filter((m) => m.finished_at).length}/${mig.rows.length}`);
    for (const m of mig.rows) console.log(`    ${m.finished_at ? "✓" : "✗ (failed)"} ${m.migration_name}`);

    const tables = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const present = new Set(tables.rows.map((t) => t.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    console.log(missing.length ? `✗ missing tables: ${missing.join(", ")}` : `✓ all ${EXPECTED_TABLES.length} model tables present`);

    for (const t of EXPECTED_TABLES.filter((x) => present.has(x))) {
      const { rows } = await client.query<{ n: string }>(`select count(*)::text as n from "${t}"`);
      console.log(`    ${t.padEnd(22)} ${rows[0].n} rows`);
    }

    // Read-only catalogue checks for the Phase 2a constraints (skipped before that migration).
    let constraintProblems = 0;
    if (present.has("generated_document")) {
      const cons = await client.query<{ conname: string; convalidated: boolean; confdeltype: string }>(
        "select conname, convalidated, confdeltype from pg_constraint where connamespace = 'public'::regnamespace",
      );
      const byName = new Map(cons.rows.map((c) => [c.conname, c]));
      for (const [table, name] of EXPECTED_CHECKS) {
        const c = byName.get(name);
        if (!c) { console.log(`✗ CHECK ${name} on ${table} missing`); constraintProblems++; }
        else if (!c.convalidated) { console.log(`✗ CHECK ${name} is NOT VALID`); constraintProblems++; }
      }
      for (const [name, rule] of EXPECTED_FKS) {
        const c = byName.get(name);
        if (!c || c.confdeltype !== rule) { console.log(`✗ foreign key ${name} missing or wrong ON DELETE rule`); constraintProblems++; }
      }
      if (!constraintProblems) console.log(`✓ ${EXPECTED_CHECKS.length} Phase 2a CHECK constraints validated, ${EXPECTED_FKS.length} foreign keys with expected ON DELETE rules`);
      const legacy = await client.query<{ bad: string }>(
        "select count(*)::text as bad from stored_file where purpose = 'unclassified' and (owner_type is distinct from 'LegacyFile' or owner_id is distinct from id)",
      );
      if (legacy.rows[0].bad !== "0") { console.log(`✗ ${legacy.rows[0].bad} legacy file(s) without the LegacyFile/<id> owner`); constraintProblems++; }
    }

    if (present.has("section")) {
      let problems = 0;
      const cons = await client.query<{ conname: string; convalidated: boolean; confdeltype: string }>(
        "select conname, convalidated, confdeltype from pg_constraint where connamespace = 'public'::regnamespace",
      );
      const byName = new Map(cons.rows.map((c) => [c.conname, c]));
      for (const [table, name] of CLASS_SECTION_CHECKS) {
        const c = byName.get(name);
        if (!c) { console.log(`✗ CHECK ${name} on ${table} missing`); problems++; }
        else if (!c.convalidated) { console.log(`✗ CHECK ${name} is NOT VALID`); problems++; }
      }
      for (const [name, rule] of CLASS_SECTION_FKS) {
        const c = byName.get(name);
        if (!c || c.confdeltype !== rule) { console.log(`✗ foreign key ${name} missing or wrong ON DELETE rule`); problems++; }
      }
      const idx = await client.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and indexname = $1", [CLASS_TEACHER_INDEX]);
      const def = idx.rows[0]?.indexdef ?? "";
      if (!/^CREATE UNIQUE INDEX/.test(def) || !/WHERE \(class_teacher_id IS NOT NULL\)/.test(def)) {
        console.log(`✗ partial unique index ${CLASS_TEACHER_INDEX} missing or not partial`);
        problems++;
      }
      if (!problems) console.log(`✓ ${CLASS_SECTION_CHECKS.length} classes/sections CHECK constraints validated, ${CLASS_SECTION_FKS.length} RESTRICT foreign keys, partial class-teacher index`);
      constraintProblems += problems;
    }

    if (present.has("employee")) {
      let problems = 0;
      const cons = await client.query<{ conname: string; convalidated: boolean; confdeltype: string }>(
        "select conname, convalidated, confdeltype from pg_constraint where connamespace = 'public'::regnamespace",
      );
      const byName = new Map(cons.rows.map((c) => [c.conname, c]));
      for (const name of HR_CHECKS) {
        const c = byName.get(name);
        if (!c) { console.log(`✗ CHECK ${name} missing`); problems++; }
        else if (!c.convalidated) { console.log(`✗ CHECK ${name} is NOT VALID`); problems++; }
      }
      for (const [name, rule] of HR_FKS) {
        const c = byName.get(name);
        if (!c || c.confdeltype !== rule) { console.log(`✗ foreign key ${name} missing or wrong ON DELETE rule`); problems++; }
      }
      const idx = await client.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public' and indexname = $1", [EMPLOYEE_PHOTO_INDEX]);
      const def = idx.rows[0]?.indexdef ?? "";
      if (!/^CREATE UNIQUE INDEX/.test(def) || !/ WHERE .*type = 'PHOTO'.*deleted_at IS NULL/.test(def)) {
        console.log(`✗ partial unique index ${EMPLOYEE_PHOTO_INDEX} missing or not partial`);
        problems++;
      }
      if (!problems) console.log(`✓ ${HR_CHECKS.length} HR CHECK constraints validated, ${HR_FKS.length} foreign keys with expected ON DELETE rules, partial employee-photo index`);
      constraintProblems += problems;
    }

    // S-07 / S-15 (created 2026-11-18): verified once their migration is recorded as applied.
    const applied = new Set(mig.rows.filter((r) => r.finished_at).map((r) => r.migration_name));
    if (applied.has("20261118000000_audit_log_append_only")) {
      const t = await client.query<{ tgname: string }>("select tgname from pg_trigger where tgrelid = 'audit_log'::regclass and not tgisinternal and tgenabled <> 'D'");
      const names = new Set(t.rows.map((r) => r.tgname));
      const ok = names.has("audit_log_no_update_delete") && names.has("audit_log_no_truncate");
      console.log(ok ? "✓ audit_log append-only triggers present and enabled (S-07)" : "✗ audit_log append-only triggers missing or disabled (S-07)");
      if (!ok) constraintProblems++;
    }
    if (applied.has("20261118000100_stored_file_purged_at")) {
      const c = await client.query<{ convalidated: boolean }>("select convalidated from pg_constraint where conname = 'stored_file_purged_check'");
      const ok = c.rows[0]?.convalidated === true;
      console.log(ok ? "✓ stored_file.purged_at CHECK validated (S-15)" : "✗ stored_file_purged_check missing or NOT VALID (S-15)");
      if (!ok) constraintProblems++;
    }

    // Phase 3B M1 (applied 2026-11-18): 20 CHECK constraints on the attendance & leave tables + school_setting.weekly_off.
    if (applied.has("20261119000000_phase3b_attendance_leave")) {
      const c = await client.query<{ n: string; v: string }>(
        "select count(*)::text n, count(*) filter (where convalidated)::text v from pg_constraint where contype = 'c' and (conrelid::regclass::text = any($1) or conname = 'school_setting_weekly_off_check')",
        [["leave_type", "leave_balance", "leave_request", "employee_attendance", "holiday", "attendance_period_lock"]],
      );
      const ok = c.rows[0]?.n === String(PHASE_3B_CHECK_COUNT) && c.rows[0]?.v === String(PHASE_3B_CHECK_COUNT);
      console.log(ok ? `✓ ${PHASE_3B_CHECK_COUNT} Phase 3B attendance & leave CHECK constraints validated` : `✗ Phase 3B CHECK constraints: ${c.rows[0]?.n} present, ${c.rows[0]?.v} validated (expected ${PHASE_3B_CHECK_COUNT})`);
      if (!ok) constraintProblems++;
    }

    // Phase 3C M1 (draft): 28 CHECKs on the payroll tables + the two employee PAN / bank pair CHECKs, 3 partial unique indexes.
    if (applied.has("20261120000000_phase3c_payroll")) {
      const c = await client.query<{ n: string; v: string }>(
        "select count(*)::text n, count(*) filter (where convalidated)::text v from pg_constraint where contype = 'c' and (conrelid::regclass::text = any($1) or conname = any($2))",
        [PHASE_3C_TABLES, ["employee_pan_pair_check", "employee_bank_pair_check"]],
      );
      const idx = await client.query<{ n: string }>("select count(*)::text n from pg_indexes where indexname = any($1) and indexdef like '% WHERE %'", [PHASE_3C_PARTIAL_INDEXES]);
      const ok = c.rows[0]?.n === String(PHASE_3C_CHECK_COUNT) && c.rows[0]?.v === String(PHASE_3C_CHECK_COUNT) && idx.rows[0]?.n === String(PHASE_3C_PARTIAL_INDEXES.length);
      console.log(
        ok
          ? `✓ ${PHASE_3C_CHECK_COUNT} Phase 3C payroll CHECK constraints validated; ${PHASE_3C_PARTIAL_INDEXES.length} partial unique indexes present`
          : `✗ Phase 3C: ${c.rows[0]?.n} CHECKs present, ${c.rows[0]?.v} validated (expected ${PHASE_3C_CHECK_COUNT}); ${idx.rows[0]?.n} partial indexes (expected ${PHASE_3C_PARTIAL_INDEXES.length})`,
      );
      if (!ok) constraintProblems++;
    }

    // Phase 4A M1 (draft): 16 CHECKs + the teacher double-booking partial unique index.
    if (applied.has("20261121000000_phase4a_teaching_attendance")) {
      const c = await client.query<{ n: string; v: string }>(
        "select count(*)::text n, count(*) filter (where convalidated)::text v from pg_constraint where contype = 'c' and (conrelid::regclass::text = any($1) or conname = 'school_setting_student_weekly_off_check')",
        [PHASE_4A_TABLES],
      );
      const idx = await client.query<{ n: string }>("select count(*)::text n from pg_indexes where indexname = 'timetable_slot_teacher_period_key' and indexdef like '% WHERE %'");
      const ok = c.rows[0]?.n === String(PHASE_4A_CHECK_COUNT) && c.rows[0]?.v === String(PHASE_4A_CHECK_COUNT) && idx.rows[0]?.n === "1";
      console.log(
        ok
          ? `✓ ${PHASE_4A_CHECK_COUNT} Phase 4A CHECK constraints validated; teacher double-booking index present`
          : `✗ Phase 4A: ${c.rows[0]?.n} CHECKs present, ${c.rows[0]?.v} validated (expected ${PHASE_4A_CHECK_COUNT}); double-booking index ${idx.rows[0]?.n === "1" ? "present" : "missing"}`,
      );
      if (!ok) constraintProblems++;
    }

    if (applied.has("20261122000000_phase4b_examinations")) {
      const c = await client.query<{ n: string; v: string }>(
        "select count(*)::text n, count(*) filter (where convalidated)::text v from pg_constraint where contype = 'c' and conrelid::regclass::text = any($1)",
        [PHASE_4B_TABLES],
      );
      const ok = c.rows[0]?.n === String(PHASE_4B_CHECK_COUNT) && c.rows[0]?.v === String(PHASE_4B_CHECK_COUNT);
      console.log(ok ? `✓ ${PHASE_4B_CHECK_COUNT} Phase 4B examination CHECK constraints validated` : `✗ Phase 4B: ${c.rows[0]?.n} CHECKs present, ${c.rows[0]?.v} validated (expected ${PHASE_4B_CHECK_COUNT})`);
      if (!ok) constraintProblems++;
    }

    if (applied.has("20261123000000_phase4c_promotion_homework_calendar")) {
      const c = await client.query<{ n: string; v: string }>(
        "select count(*)::text n, count(*) filter (where convalidated)::text v from pg_constraint where contype = 'c' and conrelid::regclass::text = any($1)",
        [PHASE_4C_TABLES],
      );
      const ok = c.rows[0]?.n === String(PHASE_4C_CHECK_COUNT) && c.rows[0]?.v === String(PHASE_4C_CHECK_COUNT);
      console.log(ok ? `✓ ${PHASE_4C_CHECK_COUNT} Phase 4C promotion / homework / calendar CHECK constraints validated` : `✗ Phase 4C: ${c.rows[0]?.n} CHECKs present, ${c.rows[0]?.v} validated (expected ${PHASE_4C_CHECK_COUNT})`);
      if (!ok) constraintProblems++;
    }

    const size = await client.query<{ bytes: string }>("select pg_database_size(current_database())::text as bytes");
    const bytes = Number(size.rows[0].bytes);
    const pct = ((bytes / FREE_STORAGE_BYTES) * 100).toFixed(1);
    const flag = bytes > FREE_STORAGE_BYTES * 0.8 ? "⚠" : "✓";
    console.log(`${flag} database size ${(bytes / 1024 ** 2).toFixed(1)} MB (${pct}% of 512 MB warning budget)`);
    if (missing.length || !ext.rowCount || constraintProblems) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
