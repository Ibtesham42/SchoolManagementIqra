import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TargetGuardError } from "@/lib/db-target-guard";
import { runDrill, type DrillClient, type DrillDeps } from "../../scripts/backup-drill-core";
import { APP_TABLES_IN_FK_ORDER } from "../../scripts/db-tables";
import pg from "pg";
import {
  assertNoJsDates,
  assertReadOnly,
  decryptBackup,
  drillSessionOptions,
  DrillError,
  encryptBackup,
  parseDrillArgs,
  resolveDrillPlan,
  TEXT_DATE_TIME_OIDS,
  textDateTimeTypes,
  toDrillJson,
  validateOutPath,
} from "../../scripts/drill-lib";

/**
 * ADR-033 backup drill (G6-0). Synthetic, in-memory only: hosts use the reserved `.invalid` TLD and
 * the database clients are recording fakes — no connection is ever opened.
 */
const DEV = { branch: "br-dev-bbbb2222", ep: "ep-dev-bbbb2222" };
const TEST = { branch: "br-test-cccc3333", ep: "ep-test-cccc3333" };
const PROD = { branch: "br-prod-aaaa1111", ep: "ep-prodn-aaaa1111" };
const DRILL = { branch: "br-drill-dddd4444", ep: "ep-drill-dddd4444" };
const SECRET = "SYNTHETIC-PASSWORD-MARKER";
const url = (ep: string, pooled = false) => `postgresql://neondb_owner:${SECRET}@${ep}${pooled ? "-pooler" : ""}.region.invalid/neondb?sslmode=verify-full`;

const devEnv = (over: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: url(DEV.ep, true),
  DIRECT_URL: url(DEV.ep),
  TEST_DATABASE_URL: url(TEST.ep, true),
  SEED_TARGET_BRANCH_ID: DEV.branch,
  SEED_TARGET_ENDPOINT_ID: DEV.ep,
  FORBIDDEN_BRANCH_IDS: PROD.branch,
  FORBIDDEN_ENDPOINT_IDS: PROD.ep,
  PRIVATE_STORAGE_LOCAL_DIR: "/data/erp-files",
  ...over,
});
const restoreEnv = (over: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: url(DRILL.ep, true),
  DIRECT_URL: url(DRILL.ep),
  DRILL_TARGET_BRANCH_ID: DRILL.branch,
  DRILL_TARGET_ENDPOINT_ID: DRILL.ep,
  ...over,
});

const noLeak = (m: string) => {
  expect(m).not.toContain(SECRET);
  expect(m).not.toContain("region.invalid");
};

// ───────────────────────────── drill-lib ─────────────────────────────

describe("arguments", () => {
  it("never accepts a connection string on the command line", () => {
    for (const a of [url(DEV.ep), "postgres://x@y/z", "--out=postgresql://a"]) expect(() => parseDrillArgs([a])).toThrow(DrillError);
  });
  it("accepts only --out <path>", () => {
    expect(parseDrillArgs([])).toEqual({ out: null });
    expect(parseDrillArgs(["--out", "/backups/a.scbak"])).toEqual({ out: "/backups/a.scbak" });
    expect(() => parseDrillArgs(["--force"])).toThrow(/Unknown option/);
    expect(() => parseDrillArgs(["--out", " "])).toThrow(/absolute path/);
  });
});

describe("source/target resolution (no connection)", () => {
  it("accepts development → the allow-listed drill branch", () => {
    const p = resolveDrillPlan(devEnv(), restoreEnv());
    expect(p.source).toMatchObject({ branchId: DEV.branch, endpointId: DEV.ep });
    expect(p.target).toMatchObject({ branchId: DRILL.branch, endpointId: DRILL.ep });
  });
  it.each<[string, Record<string, string | undefined>, Record<string, string | undefined>, RegExp]>([
    ["no forbidden branches", { FORBIDDEN_BRANCH_IDS: undefined }, {}, /FORBIDDEN_BRANCH_IDS is not set/],
    ["no forbidden endpoints", { FORBIDDEN_ENDPOINT_IDS: "" }, {}, /FORBIDDEN_ENDPOINT_IDS is not set/],
    ["no development allow-list", { SEED_TARGET_ENDPOINT_ID: undefined }, {}, /SEED_TARGET_ENDPOINT_ID/],
    ["no drill allow-list", {}, { DRILL_TARGET_ENDPOINT_ID: undefined }, /DRILL_TARGET_ENDPOINT_ID/],
    ["source not the development endpoint", { DIRECT_URL: url("ep-other-eeee5555") }, {}, /SOURCE .* not the development allow-list/],
    ["source is production", { DIRECT_URL: url(PROD.ep), SEED_TARGET_ENDPOINT_ID: PROD.ep }, {}, /SOURCE is a FORBIDDEN endpoint/],
    ["target not the drill allow-list", {}, { DIRECT_URL: url("ep-other-eeee5555") }, /TARGET .* is not DRILL_TARGET_ENDPOINT_ID/],
    ["target is production", {}, { DIRECT_URL: url(PROD.ep), DRILL_TARGET_ENDPOINT_ID: PROD.ep }, /TARGET is a FORBIDDEN endpoint/],
    ["target is development", {}, { DIRECT_URL: url(DEV.ep), DRILL_TARGET_ENDPOINT_ID: DEV.ep }, /never restores into development/],
    ["target is the test branch", {}, { DIRECT_URL: url(TEST.ep), DRILL_TARGET_ENDPOINT_ID: TEST.ep }, /never restores into the test branch/],
    ["target branch is development", {}, { DRILL_TARGET_BRANCH_ID: DEV.branch }, /forbidden or is the development branch/],
    ["target branch forbidden", {}, { DRILL_TARGET_BRANCH_ID: PROD.branch }, /forbidden or is the development branch/],
    ["target URL missing", {}, { DIRECT_URL: undefined }, /DIRECT_URL in .env.restore.local/],
  ])("refuses: %s", (_l, d, r, msg) => {
    let m = "";
    try {
      resolveDrillPlan(devEnv(d), restoreEnv(r));
    } catch (e) {
      expect(e).toBeInstanceOf(DrillError);
      m = (e as Error).message;
    }
    expect(m).toMatch(msg);
    expect(m).toContain("Nothing was read or written");
    noLeak(m);
  });
  it("the source must report a read-only session", () => {
    expect(() => assertReadOnly("on")).not.toThrow();
    for (const v of ["off", "", undefined, null]) expect(() => assertReadOnly(v)).toThrow(TargetGuardError);
  });
});

describe("encrypted backup file", () => {
  const out = (p: string) => validateOutPath(p, "/work/SchoolMang", "/data/erp-files");
  it("location: absolute, .scbak, outside the project and the file store", () => {
    expect(out("/backups/school-20261109.scbak").replace(/\\/g, "/")).toMatch(/\/backups\/school-20261109\.scbak$/);
    expect(() => out("backups/a.scbak")).toThrow(/absolute/);
    expect(() => out("/backups/a.json")).toThrow(/\.scbak/);
    expect(() => out("/work/SchoolMang/backups/a.scbak")).toThrow(/outside the project/);
    expect(() => out("/data/erp-files/a.scbak")).toThrow(/PRIVATE_STORAGE_LOCAL_DIR/);
  });
  const plain = Buffer.from(JSON.stringify({ tables: { user: [{ username: "principal", password_hash: "$argon2id$synthetic" }] } }));
  const pass = "correct horse battery staple";
  it("round-trips with the passphrase; the file never contains the plaintext", () => {
    const f = encryptBackup(plain, pass, "2026-11-09T00:00:00Z");
    expect(f.includes(Buffer.from("principal"))).toBe(false);
    expect(f.includes(Buffer.from("argon2"))).toBe(false);
    const d = decryptBackup(f, pass);
    expect(d.plaintext.equals(plain)).toBe(true);
    expect(d.takenAt).toBe("2026-11-09T00:00:00Z");
  });
  it("fails closed on a wrong passphrase, a modified body, a modified header or truncation", () => {
    const f = encryptBackup(plain, pass, "t");
    expect(() => decryptBackup(f, "wrong passphrase!!")).toThrow(/wrong passphrase or the file was modified/);
    const body = Buffer.from(f);
    body[body.length - 20] ^= 1;
    expect(() => decryptBackup(body, pass)).toThrow(DrillError);
    const header = Buffer.from(f.toString("latin1").replace('"takenAt":"t"', '"takenAt":"u"'), "latin1");
    expect(() => decryptBackup(header, pass)).toThrow(DrillError);
    expect(() => decryptBackup(f.subarray(0, 40), pass)).toThrow(DrillError);
    expect(() => decryptBackup(Buffer.from("not a backup"), pass)).toThrow(/Not a SchoolERP backup/);
  });
  it("requires a passphrase of at least 12 characters", () => {
    expect(() => encryptBackup(plain, "short", "t")).toThrow(/at least 12/);
  });
});

// ───────────────────────────── orchestration (fake clients) ─────────────────────────────

interface FakeDb {
  client: DrillClient;
  queries: string[];
  rows: Record<string, unknown[]>;
}

function fakeDb(opts: {
  identity: { branch: string | null; endpoint: string | null };
  readOnly?: string;
  rows?: Record<string, unknown[]>;
  extraTable?: string;
  /** id the write check's INSERT … RETURNING reports; default: restored max + 1; null = no row. */
  nextAuditId?: string | null;
}): FakeDb {
  const rows: Record<string, unknown[]> = Object.fromEntries(APP_TABLES_IN_FK_ORDER.map((t) => [t, []]));
  Object.assign(rows, opts.rows ?? {});
  const queries: string[] = [];
  const client: DrillClient = {
    async query<T>(sql: string, params?: unknown[]) {
      queries.push(sql);
      const r = (x: unknown[]) => ({ rows: x as T[] });
      if (sql === "SHOW transaction_read_only") return r([{ transaction_read_only: opts.readOnly ?? "off" }]);
      if (sql.includes("current_setting('neon.branch_id'")) return r([opts.identity]);
      if (sql.includes("information_schema.tables")) return r([...APP_TABLES_IN_FK_ORDER, ...(opts.extraTable ? [opts.extraTable] : [])].map((t) => ({ table_name: t })));
      let m = sql.match(/^SELECT count\(\*\)::int AS n FROM "(\w+)"$/);
      if (m) return r([{ n: rows[m[1]].length }]);
      m = sql.match(/md5\(string_agg.* FROM "(\w+)" t$/);
      if (m) return r([{ n: String(rows[m[1]].length), md5: rows[m[1]].length ? `md5-${JSON.stringify(rows[m[1]])}` : null }]);
      m = sql.match(/^SELECT \* FROM "(\w+)"$/);
      if (m) return r(rows[m[1]]);
      m = sql.match(/^INSERT INTO "(\w+)" SELECT \* FROM json_populate_recordset/);
      if (m) {
        rows[m[1]] = JSON.parse(String(params![0]));
        return r([]);
      }
      m = sql.match(/^UPDATE "(\w+)" AS d SET "(\w+)" = s\."\2" FROM json_populate_recordset\(NULL::"\1", \$1::json\) s WHERE d\."id" = s\."id"$/);
      if (m) {
        const [, table, col] = m;
        for (const u of JSON.parse(String(params![0])) as Record<string, unknown>[]) {
          const target = (rows[table] as Record<string, unknown>[]).find((x) => x.id === u.id);
          if (target) target[col] = u[col];
        }
        return r([]);
      }
      if (sql.startsWith("INSERT INTO audit_log (action, entity_type)") && sql.includes("RETURNING id")) {
        if (opts.nextAuditId === null) return r([]);
        const max = rows.audit_log.reduce<bigint>((a, x) => (BigInt(String((x as { id: unknown }).id)) > a ? BigInt(String((x as { id: unknown }).id)) : a), 0n);
        return r([{ id: opts.nextAuditId ?? String(max + 1n) }]);
      }
      return r([]);
    },
    async end() {},
  };
  return { client, queries, rows };
}

function drillDeps(opts: { source?: FakeDb; target?: FakeDb; dev?: Record<string, string | undefined>; restore?: Record<string, string | undefined>; shell?: Record<string, string>; interactive?: boolean } = {}) {
  const source = opts.source ?? fakeDb({ identity: { branch: DEV.branch, endpoint: DEV.ep }, readOnly: "on", rows: { role: [{ id: "r1", key: "SUPER_ADMIN" }], user: [{ id: "u1", password_hash: "$argon2id$x" }] } });
  const target = opts.target ?? fakeDb({ identity: { branch: DRILL.branch, endpoint: DRILL.ep } });
  const connects: { url: string; readOnly: boolean }[] = [];
  const logs: string[] = [];
  const files: Record<string, Buffer> = {};
  const deps: DrillDeps = {
    shellEnv: opts.shell ?? {},
    loadDevEnv: () => devEnv(opts.dev),
    loadRestoreEnv: () => restoreEnv(opts.restore),
    connect: async (u, { readOnly }) => {
      connects.push({ url: u, readOnly });
      return u.includes(DEV.ep) ? source.client : target.client;
    },
    isInteractive: () => opts.interactive ?? false,
    promptPassphrase: async () => "correct horse battery staple",
    writeFile: (p, d) => void (files[p] = d),
    log: (l) => void logs.push(l),
    projectDir: "/work/SchoolMang",
  };
  return { deps, source, target, connects, logs, files };
}

const writesIn = (q: string[]) => q.filter((s) => /^(BEGIN|INSERT|UPDATE|DELETE|COMMIT|SELECT setval)/.test(s));

describe("runDrill ordering and refusals", () => {
  it("happy path: source read-only + identity → target identity + empty → copy → identical", async () => {
    const r = drillDeps();
    expect(await runDrill([], r.deps)).toBe(true);
    expect(r.connects.map((c) => c.readOnly)).toEqual([true, false]); // source first, read-only
    expect(writesIn(r.source.queries)).toEqual([]); // the source is never written
    expect(r.target.rows.role).toEqual([{ id: "r1", key: "SUPER_ADMIN" }]);
    expect(r.logs.join("\n")).toContain("DRILL PASSED");
    expect(r.logs.join("\n")).not.toMatch(/argon2|SYNTHETIC|region\.invalid/);
  });
  it("refuses before any connection when DOTENV_PATH or a database URL is set in the shell", async () => {
    const shells: Record<string, string>[] = [{ DOTENV_PATH: ".env.test" }, { DATABASE_URL: url(DEV.ep) }];
    for (const shell of shells) {
      const r = drillDeps({ shell });
      await expect(runDrill([], r.deps)).rejects.toBeInstanceOf(TargetGuardError);
      expect(r.connects).toEqual([]);
    }
  });
  it("refuses before any connection when the plan is invalid (e.g. target = test)", async () => {
    const r = drillDeps({ restore: { DIRECT_URL: url(TEST.ep), DRILL_TARGET_ENDPOINT_ID: TEST.ep } });
    await expect(runDrill([], r.deps)).rejects.toBeInstanceOf(DrillError);
    expect(r.connects).toEqual([]);
  });
  it("refuses to read a source whose session is not read-only", async () => {
    const r = drillDeps({ source: fakeDb({ identity: { branch: DEV.branch, endpoint: DEV.ep }, readOnly: "off" }) });
    await expect(runDrill([], r.deps)).rejects.toThrow(/not read-only/);
    expect(r.source.queries.some((q) => q.startsWith("SELECT * FROM"))).toBe(false);
    expect(r.connects).toHaveLength(1); // target never opened
  });
  it("refuses when the live source is not the development branch (e.g. production) — target never opened", async () => {
    const r = drillDeps({ source: fakeDb({ identity: { branch: PROD.branch, endpoint: DEV.ep }, readOnly: "on" }) });
    await expect(runDrill([], r.deps)).rejects.toBeInstanceOf(TargetGuardError);
    expect(r.connects).toHaveLength(1);
  });
  it("refuses when the live target is not the drill branch — nothing written", async () => {
    const r = drillDeps({ target: fakeDb({ identity: { branch: TEST.branch, endpoint: DRILL.ep } }) });
    await expect(runDrill([], r.deps)).rejects.toBeInstanceOf(TargetGuardError);
    expect(writesIn(r.target.queries)).toEqual([]);
  });
  it("refuses a non-empty target — nothing written", async () => {
    const r = drillDeps({ target: fakeDb({ identity: { branch: DRILL.branch, endpoint: DRILL.ep }, rows: { user: [{ id: "x" }] } }) });
    await expect(runDrill([], r.deps)).rejects.toThrow(/not empty/);
    expect(writesIn(r.target.queries)).toEqual([]);
  });
  it("refuses a source table the drill does not cover — nothing written", async () => {
    // "fee_invoice": a future table (Phase 5) that the drill does not cover yet.
    const r = drillDeps({ source: fakeDb({ identity: { branch: DEV.branch, endpoint: DEV.ep }, readOnly: "on", extraTable: "fee_invoice" }) });
    await expect(runDrill([], r.deps)).rejects.toThrow(/not covered/);
    expect(writesIn(r.target.queries)).toEqual([]);
  });
  it("--out: refused without a terminal; written encrypted (and decryptable) with one", async () => {
    const nonTty = drillDeps();
    await expect(runDrill(["--out", "/backups/d.scbak"], nonTty.deps)).rejects.toThrow(/interactive terminal/);
    expect(nonTty.connects).toEqual([]);
    const tty = drillDeps({ interactive: true });
    expect(await runDrill(["--out", "/backups/d.scbak"], tty.deps)).toBe(true);
    const [path, file] = Object.entries(tty.files)[0];
    expect(path.replace(/\\/g, "/")).toMatch(/\/backups\/d\.scbak$/);
    expect(file.includes(Buffer.from("argon2"))).toBe(false);
    expect(JSON.parse(decryptBackup(file, "correct horse battery staple").plaintext.toString()).tables.role).toHaveLength(1);
  });
  it("--out inside the project is refused before connecting", async () => {
    const r = drillDeps({ interactive: true });
    await expect(runDrill(["--out", "/work/SchoolMang/b.scbak"], r.deps)).rejects.toThrow(/outside the project/);
    expect(r.connects).toEqual([]);
  });
});

describe("write check: the restored audit_log identity continues", () => {
  const audit = [{ id: "7" }, { id: "42" }, { id: "9" }];
  const src = () => fakeDb({ identity: { branch: DEV.branch, endpoint: DEV.ep }, readOnly: "on", rows: { audit_log: audit } });
  const tgt = (nextAuditId?: string | null) => fakeDb({ identity: { branch: DRILL.branch, endpoint: DRILL.ep }, nextAuditId });
  const tail = (q: string[]) => q.slice(q.findLastIndex((s) => s === "BEGIN"));

  it("passes when the new id is above the restored max, and always rolls back", async () => {
    const r = drillDeps({ source: src(), target: tgt() });
    expect(await runDrill([], r.deps)).toBe(true);
    expect(r.logs.join("\n")).toContain("new audit_log id 43 > restored max 42; rolled back");
    const check = tail(r.target.queries);
    expect(check[1]).toMatch(/RETURNING id/);
    expect(check.at(-1)).toBe("ROLLBACK");
    expect(check).not.toContain("COMMIT");
  });
  it.each<[string, string | null]>([
    ["equal to the restored max", "42"],
    ["below the restored max (sequence not reset)", "10"],
    ["no id returned", null],
  ])("fails the drill when the new id is %s — still rolled back", async (_l, next) => {
    const r = drillDeps({ source: src(), target: tgt(next) });
    expect(await runDrill([], r.deps)).toBe(false);
    const log = r.logs.join("\n");
    expect(log).toMatch(/✗ write check: new audit_log id (42|10|missing) is not above the restored max 42/);
    expect(log).toContain("DRILL FAILED");
    expect(tail(r.target.queries).at(-1)).toBe("ROLLBACK");
  });
  it("an empty audit_log: the first id must be above 0", async () => {
    const r = drillDeps();
    expect(await runDrill([], r.deps)).toBe(true);
    expect(r.logs.join("\n")).toContain("new audit_log id 1 > restored max 0");
  });
});

describe("user ↔ employee foreign-key cycle (Phase 3A, DEFERRED_FK_COLUMNS)", () => {
  // Synthetic rows: an employee created by user u1, and u1's account linked to that employee.
  const user = { id: "u1", username: "demo.hr", employee_id: "e1" };
  const unlinked = { id: "u2", username: "demo.clerk", employee_id: null };
  const employee = { id: "e1", employee_code: "EMP-2026-0001", created_by_id: "u1" };

  it("inserts the account without its employee link, then links it after the employee row exists — one transaction", async () => {
    const source = fakeDb({ identity: { branch: DEV.branch, endpoint: DEV.ep }, readOnly: "on", rows: { user: [user, unlinked], employee: [employee] } });
    const r = drillDeps({ source });
    const inserted: Record<string, unknown>[] = [];
    const query = r.target.client.query.bind(r.target.client);
    r.target.client.query = (async (sql: string, params?: unknown[]) => {
      if (sql.startsWith(`INSERT INTO "user"`)) inserted.push(...(JSON.parse(String(params![0])) as Record<string, unknown>[]));
      return query(sql, params);
    }) as typeof r.target.client.query;

    expect(await runDrill([], r.deps)).toBe(true);
    expect(inserted).toEqual([{ ...user, employee_id: null }, unlinked]); // no forward reference at insert time
    const writes = writesIn(r.target.queries);
    const userInsert = writes.findIndex((q) => q.startsWith(`INSERT INTO "user"`));
    const employeeInsert = writes.findIndex((q) => q.startsWith(`INSERT INTO "employee"`));
    const link = writes.findIndex((q) => q.startsWith(`UPDATE "user"`));
    expect(userInsert).toBeLessThan(employeeInsert);
    expect(employeeInsert).toBeLessThan(link);
    expect(writes.slice(0, writes.indexOf("COMMIT")).filter((q) => q === "BEGIN")).toHaveLength(1);
    expect(link).toBeLessThan(writes.indexOf("COMMIT"));
    expect(r.target.rows.user).toEqual([user, unlinked]); // checksums identical → drill passed
  });

  it("issues no link update when no account is linked", async () => {
    const source = fakeDb({ identity: { branch: DEV.branch, endpoint: DEV.ep }, readOnly: "on", rows: { user: [unlinked] } });
    const r = drillDeps({ source });
    expect(await runDrill([], r.deps)).toBe(true);
    expect(r.target.queries.some((q) => q.startsWith("UPDATE"))).toBe(false);
  });
});

describe("timezone-safe date/time round-trip (@db.Date)", () => {
  const ZONES = ["Asia/Kolkata", "UTC"] as const;
  const originalTz = process.env.TZ;
  const withTz = <T>(tz: string, fn: () => T): T => {
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  };
  // What PostgreSQL sends in text format (ISO DateStyle, UTC session).
  const WIRE = { 1082: "2026-04-01", 1114: "2026-04-01 00:00:00.123", 1184: "2026-04-01 00:00:00.123+00", 1182: "{2026-04-01,2026-04-02}" } as const;

  it("the timezone switch is effective in this runtime (IST = UTC+05:30)", () => {
    expect(withTz("Asia/Kolkata", () => new Date(2026, 3, 1).getTimezoneOffset())).toBe(-330);
    expect(withTz("UTC", () => new Date(2026, 3, 1).getTimezoneOffset())).toBe(0);
  });

  it("regression: node-pg's default date parser loses a day in IST once written as JSON", () => {
    const iso = withTz("Asia/Kolkata", () => toDrillJson(pg.types.getTypeParser(1082, "text")("2026-04-01")));
    expect(iso).toBe('"2026-03-31T18:30:00.000Z"'); // json_populate_recordset → date 2026-03-31
  });

  it.each(ZONES)("drill sessions keep date, timestamp, timestamptz and date[] as exact text in %s", (tz) => {
    const types = textDateTimeTypes(pg.types);
    withTz(tz, () => {
      for (const [oid, wire] of Object.entries(WIRE)) expect(types.getTypeParser(Number(oid), "text")(wire)).toBe(wire);
      expect(toDrillJson({ start_date: types.getTypeParser(1082, "text")("2026-04-01") })).toBe('{"start_date":"2026-04-01"}');
    });
  });

  it("other types still use node-pg's parsers (int4 → number, bool → boolean, jsonb → object)", () => {
    const types = textDateTimeTypes(pg.types);
    expect(types.getTypeParser(23, "text")("5")).toBe(5);
    expect(types.getTypeParser(16, "text")("t")).toBe(true);
    expect(types.getTypeParser(3802, "text")('{"a":1}')).toEqual({ a: 1 });
    for (const oid of [1082, 1083, 1114, 1184, 1186, 1266, 1182, 1183, 1115, 1185, 1187, 1270]) expect(TEXT_DATE_TIME_OIDS.has(oid)).toBe(true);
  });

  it("both sessions run in UTC with ISO dates; only the source is read-only", () => {
    expect(drillSessionOptions(true)).toBe("-c TimeZone=UTC -c DateStyle=ISO,YMD -c default_transaction_read_only=on");
    expect(drillSessionOptions(false)).toBe("-c TimeZone=UTC -c DateStyle=ISO,YMD");
  });

  it.each(ZONES)("runDrill restores academic_session dates unchanged in %s", async (tz) => {
    const sessionRow = { id: "s1", name: "2026-27", start_date: "2026-04-01", end_date: "2027-03-31", created_at: "2026-11-09 14:13:45.123+00" };
    const source = fakeDb({ identity: { branch: DEV.branch, endpoint: DEV.ep }, readOnly: "on", rows: { academic_session: [sessionRow] } });
    const r = drillDeps({ source });
    process.env.TZ = tz;
    try {
      expect(await runDrill([], r.deps)).toBe(true);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
    expect(r.target.rows.academic_session).toEqual([sessionRow]);
  });

  it("refuses rows holding JS Dates (a session parsing dates locally) before anything is written", async () => {
    const source = fakeDb({ identity: { branch: DEV.branch, endpoint: DEV.ep }, readOnly: "on", rows: { academic_session: [{ id: "s1", start_date: new Date(2026, 3, 1) }] } });
    const r = drillDeps({ source });
    await expect(runDrill([], r.deps)).rejects.toThrow(/"academic_session"."start_date" was read as a JS Date/);
    expect(writesIn(r.target.queries)).toEqual([]);
    expect(() => assertNoJsDates("t", [{ a: "2026-04-01", b: 1, c: null }])).not.toThrow();
  });
});

describe("drill credentials file is protected", () => {
  it(".env.restore.local is denied to Claude Code and git-ignored", () => {
    const settings = JSON.parse(readFileSync(new URL("../../.claude/settings.json", import.meta.url), "utf8")) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(./.env.*.local)", "Edit(./.env.*.local)"]));
    expect(readFileSync(new URL("../../.gitignore", import.meta.url), "utf8")).toMatch(/^\.env\.\*$/m);
  });
});
