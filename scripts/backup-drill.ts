/**
 * Logical backup → restore drill (docs/BACKUP_AND_RECOVERY.md, ADR-033):
 *
 *   npm run backup:drill                          # in-memory only
 *   npm run backup:drill -- --out D:\backups\school-YYYYMMDD.scbak   # + encrypted backup file
 *
 * SOURCE is development (`.env`), read in a read-only session; TARGET is a disposable drill branch
 * (`.env.restore.local`, written by `npm run drill:env`). No connection strings on the command
 * line; both live identities are checked against allow-lists before anything is read or written.
 * Logic in scripts/backup-drill-core.ts and scripts/drill-lib.ts. This file never prints secrets.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import pg from "pg";
import { runDrill } from "./backup-drill-core";
import { drillSessionOptions, MIN_PASSPHRASE, textDateTimeTypes } from "./drill-lib";

const shellEnv = { ...process.env }; // captured before anything reads an env file

const readEnvFile = (name: string): Record<string, string | undefined> => {
  const p = resolve(process.cwd(), name);
  if (!existsSync(p)) throw new Error(`${name} not found in the project folder.`);
  return parseDotenv(readFileSync(p));
};

function readHidden(question: string): Promise<string> {
  return new Promise((done, fail) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return done(value);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          return fail(new Error("Cancelled — nothing was written."));
        }
        if (ch === "\u0008" || ch === "\u007f") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const sanitize = (m: string) => m.replace(/postgres(ql)?:\/\/[^\s]+/g, "<url>").replace(/npg_[A-Za-z0-9]+/g, "***");

runDrill(process.argv.slice(2), {
  shellEnv,
  loadDevEnv: () => readEnvFile(".env"),
  loadRestoreEnv: () => readEnvFile(".env.restore.local"),
  connect: async (url, { readOnly }) => {
    // UTC/ISO sessions and date/time values as text: timezone-safe on any machine (drill-lib).
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 30_000, options: drillSessionOptions(readOnly), types: textDateTimeTypes(pg.types) });
    await c.connect();
    return c as unknown as import("./backup-drill-core").DrillClient;
  },
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  promptPassphrase: async () => {
    const a = await readHidden(`Backup passphrase (hidden, ${MIN_PASSPHRASE}+ characters): `);
    const b = await readHidden("Repeat passphrase: ");
    if (a !== b) throw new Error("Passphrases did not match — nothing was written.");
    return a;
  },
  writeFile: (p, data) => writeFileSync(p, data, { flag: "wx" }), // never overwrite an existing backup
  log: (l) => console.log(l),
  projectDir: process.cwd(),
})
  .then((ok) => {
    if (!ok) process.exitCode = 1;
  })
  .catch((e: unknown) => {
    console.error(`DRILL FAILED: ${sanitize(e instanceof Error ? e.message : String(e))}`);
    process.exitCode = 1;
  });
