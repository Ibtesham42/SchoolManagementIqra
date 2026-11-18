/**
 * Backup → restore drill orchestration (ADR-033). All side effects are injected so the ordering
 * and every refusal are unit-tested (tests/unit/backup-drill.test.ts):
 *
 *   shell clean → resolve plan from .env + .env.restore.local (no connection)
 *   → connect SOURCE read-only, confirm transaction_read_only = on, confirm live identity
 *   → connect TARGET, confirm live identity, confirm every table empty
 *   → read all tables from SOURCE → restore into TARGET in ONE transaction → verify checksums
 *   → write check (new audit_log id > restored max; rolled back)
 *   → optional: write the backup ENCRYPTED to an approved path.
 * Sessions must return date/time values as text (drill-lib textDateTimeTypes); JS Dates are refused.
 */
import { assertLiveIdentity, assertShellClean, IDENTITY_SQL, type DbIdentity } from "../src/lib/db-target-guard";
import { APP_TABLES_IN_FK_ORDER, DEFERRED_FK_COLUMNS } from "./db-tables";
import { assertNoJsDates, assertReadOnly, DrillError, encryptBackup, parseDrillArgs, resolveDrillPlan, toDrillJson, validateOutPath } from "./drill-lib";

export interface DrillClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export interface DrillDeps {
  shellEnv: Record<string, string | undefined>;
  loadDevEnv(): Record<string, string | undefined>;
  loadRestoreEnv(): Record<string, string | undefined>;
  /** readOnly → the session must be opened with default_transaction_read_only = on. */
  connect(url: string, opts: { readOnly: boolean }): Promise<DrillClient>;
  isInteractive(): boolean;
  promptPassphrase(): Promise<string>;
  writeFile(path: string, data: Buffer): void;
  log(line: string): void;
  projectDir: string;
}

const TABLES: readonly string[] = APP_TABLES_IN_FK_ORDER;

async function checksum(c: DrillClient, table: string): Promise<string> {
  const { rows } = await c.query<{ n: string; md5: string | null }>(`SELECT count(*)::text AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS md5 FROM "${table}" t`);
  return `${rows[0].n}:${rows[0].md5 ?? "empty"}`;
}

export async function runDrill(argv: string[], deps: DrillDeps): Promise<boolean> {
  const args = parseDrillArgs(argv);
  assertShellClean(deps.shellEnv);
  const devEnv = deps.loadDevEnv();
  const plan = resolveDrillPlan(devEnv, deps.loadRestoreEnv());
  const outPath = args.out ? validateOutPath(args.out, deps.projectDir, devEnv.PRIVATE_STORAGE_LOCAL_DIR) : null;
  if (outPath && !deps.isInteractive()) throw new DrillError("--out asks for a passphrase and must be run by you in an interactive terminal.");
  const passphrase = outPath ? await deps.promptPassphrase() : null;
  deps.log("✓ plan: SOURCE = development allow-list, TARGET = drill allow-list (not forbidden, not development, not test)");

  const src = await deps.connect(plan.sourceUrl, { readOnly: true });
  let dst: DrillClient | null = null;
  try {
    assertReadOnly((await src.query<{ transaction_read_only: string }>("SHOW transaction_read_only")).rows[0]?.transaction_read_only);
    assertLiveIdentity((await src.query<DbIdentity>(IDENTITY_SQL)).rows[0], plan.source);
    deps.log("✓ SOURCE: read-only session on the development branch");

    dst = await deps.connect(plan.targetUrl, { readOnly: false });
    assertLiveIdentity((await dst.query<DbIdentity>(IDENTITY_SQL)).rows[0], plan.target);
    for (const t of TABLES) {
      const { rows } = await dst.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`);
      if (rows[0].n > 0) throw new DrillError(`Refusing: TARGET table "${t}" is not empty. Nothing was written.`);
    }
    deps.log("✓ TARGET: the drill branch, all 16 tables empty");

    const srcTables = await src.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'",
    );
    const unknown = srcTables.rows.map((r) => r.table_name).filter((t) => !TABLES.includes(t));
    if (unknown.length) throw new DrillError(`Refusing: SOURCE has tables not covered by the drill: ${unknown.join(", ")} (update scripts/db-tables.ts)`);

    // 1. Backup (in memory)
    const t0 = Date.now();
    const backup: Record<string, unknown[]> = {};
    for (const t of TABLES) {
      backup[t] = (await src.query(`SELECT * FROM "${t}"`)).rows;
      assertNoJsDates(t, backup[t]);
    }
    const takenAt = new Date().toISOString();
    const json = Buffer.from(toDrillJson({ takenAt, tables: backup }), "utf8");
    deps.log(`backup: ${TABLES.length} tables, ${(json.length / 1024).toFixed(1)} KB in ${Date.now() - t0} ms`);

    // 2. Restore — one transaction on the TARGET
    const t1 = Date.now();
    await dst.query("BEGIN");
    try {
      for (const t of TABLES) {
        if (!backup[t].length) continue;
        const deferred = DEFERRED_FK_COLUMNS[t as keyof typeof DEFERRED_FK_COLUMNS] ?? [];
        const rows = backup[t].map((r) => {
          const row = r as Record<string, unknown>;
          const set = deferred.filter((c) => row[c] != null);
          return set.length ? { ...row, ...Object.fromEntries(set.map((c) => [c, null])) } : row;
        });
        await dst.query(`INSERT INTO "${t}" SELECT * FROM json_populate_recordset(NULL::"${t}", $1::json)`, [toDrillJson(rows)]);
      }
      // Backward foreign keys (the user ↔ employee cycle): set once every referenced row exists.
      for (const [t, cols] of Object.entries(DEFERRED_FK_COLUMNS)) {
        for (const c of cols ?? []) {
          const linked = backup[t].filter((r) => (r as Record<string, unknown>)[c] != null).map((r) => ({ id: (r as { id: unknown }).id, [c]: (r as Record<string, unknown>)[c] }));
          if (!linked.length) continue;
          await dst.query(`UPDATE "${t}" AS d SET "${c}" = s."${c}" FROM json_populate_recordset(NULL::"${t}", $1::json) s WHERE d."id" = s."id"`, [toDrillJson(linked)]);
        }
      }
      await dst.query(`SELECT setval(pg_get_serial_sequence('audit_log','id'), COALESCE((SELECT max(id) FROM audit_log), 0) + 1, false)`);
      await dst.query("COMMIT");
    } catch (e) {
      await dst.query("ROLLBACK");
      throw e;
    }
    deps.log(`restore: committed in ${Date.now() - t1} ms`);

    // 3. Verify
    let ok = true;
    for (const t of TABLES) {
      const [a, b] = [await checksum(src, t), await checksum(dst, t)];
      const same = a === b;
      ok &&= same;
      deps.log(`${same ? "✓" : "✗"} ${t.padEnd(22)} ${a.split(":")[0].padStart(4)} rows  ${same ? "identical" : "MISMATCH"}`);
    }
    // Write check: a new audit row must get an id above every restored id (sequence reset correctly).
    const restoredMax = backup.audit_log.reduce<bigint>((m, r) => {
      const id = BigInt(String((r as { id: unknown }).id));
      return id > m ? id : m;
    }, 0n);
    let newId: bigint | null = null;
    await dst.query("BEGIN");
    try {
      const { rows } = await dst.query<{ id: string }>(`INSERT INTO audit_log (action, entity_type) VALUES ('backup.drill.write_check', 'Drill') RETURNING id::text AS id`);
      newId = rows[0]?.id !== undefined ? BigInt(rows[0].id) : null;
    } finally {
      await dst.query("ROLLBACK");
    }
    if (newId !== null && newId > restoredMax) {
      deps.log(`✓ restored database accepts new writes (new audit_log id ${newId} > restored max ${restoredMax}; rolled back)`);
    } else {
      ok = false;
      deps.log(`✗ write check: new audit_log id ${newId ?? "missing"} is not above the restored max ${restoredMax} (rolled back)`);
    }

    // 4. Optional encrypted backup file
    if (outPath && passphrase) {
      deps.writeFile(outPath, encryptBackup(json, passphrase, takenAt));
      deps.log("✓ encrypted backup written (AES-256-GCM, scrypt-derived key); keep the passphrase offline");
    }
    deps.log(ok ? "DRILL PASSED" : "DRILL FAILED");
    return ok;
  } finally {
    await src.end();
    if (dst) await dst.end();
  }
}
