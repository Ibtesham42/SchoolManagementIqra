/**
 * Logical backup → restore drill (docs/BACKUP_AND_RECOVERY.md).
 *
 *   tsx scripts/backup-drill.ts <SOURCE_URL> <TARGET_URL> [backupFile]
 *
 * 1. Exports every application table from SOURCE as JSON (file written only if backupFile given).
 * 2. Restores into TARGET, which must already be migrated and EMPTY (refuses otherwise).
 * 3. Resets identity sequences so new rows don't collide with restored ids.
 * 4. Verifies per-table row counts and content checksums are identical, and that the
 *    restored database accepts new writes.
 *
 * Never point TARGET at production. The backup contains password hashes and personal data:
 * keep any backup file on encrypted storage and delete drill copies afterwards.
 */
import { writeFileSync } from "node:fs";
import pg from "pg";

// Parent tables first (FK order).
const TABLES = [
  "role", "permission", "role_permission", "academic_session", "school_setting", "user", "user_role",
  "session", "password_reset_token", "stored_file", "audit_log", "notification", "sequence_counter",
  "rate_limit_bucket", "usage_counter",
];

async function checksum(c: pg.Client, table: string) {
  const { rows } = await c.query<{ n: string; md5: string | null }>(
    `SELECT count(*)::text AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS md5 FROM "${table}" t`,
  );
  return `${rows[0].n}:${rows[0].md5 ?? "empty"}`;
}

async function main() {
  const [source, target, file] = process.argv.slice(2);
  if (!source || !target) throw new Error("usage: backup-drill <SOURCE_URL> <TARGET_URL> [backupFile]");
  if (/prod/i.test(target)) throw new Error("Refusing: TARGET looks like production");

  const src = new pg.Client({ connectionString: source });
  const dst = new pg.Client({ connectionString: target });
  await src.connect();
  await dst.connect();
  try {
    // ── 1. Backup
    const t0 = Date.now();
    const backup: Record<string, unknown[]> = {};
    for (const t of TABLES) backup[t] = (await src.query(`SELECT * FROM "${t}"`)).rows;
    const json = JSON.stringify({ takenAt: new Date().toISOString(), tables: backup });
    if (file) writeFileSync(file, json, "utf8");
    console.log(`backup: ${TABLES.length} tables, ${(json.length / 1024).toFixed(1)} KB in ${Date.now() - t0} ms`);

    // ── 2. Restore (target must be migrated + empty)
    for (const t of TABLES) {
      const { rows } = await dst.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`);
      if (rows[0].n > 0) throw new Error(`Refusing: target table "${t}" is not empty`);
    }
    const t1 = Date.now();
    await dst.query("BEGIN");
    try {
      for (const t of TABLES) {
        if (backup[t].length === 0) continue;
        await dst.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json)`, [
          JSON.stringify(backup[t]),
        ]);
      }
      // ── 3. Identity sequences continue after restored ids
      await dst.query(`SELECT setval(pg_get_serial_sequence('audit_log','id'), COALESCE((SELECT max(id) FROM audit_log), 0) + 1, false)`);
      await dst.query("COMMIT");
    } catch (e) {
      await dst.query("ROLLBACK");
      throw e;
    }
    console.log(`restore: committed in ${Date.now() - t1} ms`);

    // ── 4. Verify
    let ok = true;
    for (const t of TABLES) {
      const [a, b] = [await checksum(src, t), await checksum(dst, t)];
      const same = a === b;
      ok &&= same;
      console.log(`${same ? "✓" : "✗"} ${t.padEnd(22)} ${a.split(":")[0].padStart(4)} rows  ${same ? "identical" : `MISMATCH ${a} vs ${b}`}`);
    }
    // New writes must work on the restored DB (catches stale identity sequences).
    await dst.query("BEGIN");
    await dst.query(`INSERT INTO audit_log (action, entity_type) VALUES ('backup.drill.write_check', 'Drill')`);
    await dst.query("ROLLBACK");
    console.log("✓ restored database accepts new writes (audit_log identity continues)");
    if (!ok) process.exitCode = 1;
    console.log(ok ? "DRILL PASSED" : "DRILL FAILED");
  } finally {
    await src.end();
    await dst.end();
  }
}

main().catch((e) => {
  console.error("DRILL FAILED:", (e as Error).message);
  process.exitCode = 1;
});
