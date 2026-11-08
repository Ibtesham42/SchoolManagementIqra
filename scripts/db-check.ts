/**
 * Database verification: `npm run db:check`
 * Confirms connectivity on both URLs, server version, pgvector, applied migrations,
 * that every Prisma model's table exists, row counts, and Neon free-tier storage use.
 * Prints no secrets (hosts are shown, credentials are not).
 */
import "dotenv/config";
import pg from "pg";

const FREE_STORAGE_BYTES = 0.5 * 1024 ** 3; // conservative: Neon Free is 0.5–1 GB/project; warn early
const EXPECTED_TABLES = [
  "user", "session", "password_reset_token", "role", "permission", "role_permission", "user_role",
  "school_setting", "academic_session", "sequence_counter", "stored_file", "audit_log", "notification",
  "rate_limit_bucket", "usage_counter",
];

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

    const size = await client.query<{ bytes: string }>("select pg_database_size(current_database())::text as bytes");
    const bytes = Number(size.rows[0].bytes);
    const pct = ((bytes / FREE_STORAGE_BYTES) * 100).toFixed(1);
    const flag = bytes > FREE_STORAGE_BYTES * 0.8 ? "⚠" : "✓";
    console.log(`${flag} database size ${(bytes / 1024 ** 2).toFixed(1)} MB (${pct}% of 512 MB warning budget)`);
    if (missing.length || !ext.rowCount) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
