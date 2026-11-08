import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { hashPassword } from "../../src/lib/auth/password";

/**
 * Creates disposable e2e users (one set per browser project) in the DEVELOPMENT database
 * the server under test uses (E2E_DATABASE_URL). Requires the seed to have run (roles exist).
 * Passwords are random per run and written only to playwright/.cache/ (git-ignored).
 */
export const PROJECTS = ["desktop-chrome", "pixel-7", "iphone-14"] as const;

export default async function globalSetup() {
  const url = process.env.E2E_DATABASE_URL;
  if (!url) {
    console.log("[e2e] E2E_DATABASE_URL not set — database-dependent specs will be skipped (pending).");
    return;
  }
  if (/prod/i.test(url)) throw new Error("Refusing to run e2e setup against a URL that looks like production");

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const creds: Record<string, { admin: string; readyAdmin: string; teacher: string; password: string; newPassword: string }> = {};
  try {
    await client.query(`DELETE FROM "user" WHERE username LIKE 'e2e-%'`);
    const roles = await client.query<{ id: string; key: string }>(`SELECT id, key FROM role WHERE key IN ('SUPER_ADMIN','TEACHER')`);
    const roleId = (k: string) => {
      const r = roles.rows.find((x) => x.key === k);
      if (!r) throw new Error(`Role ${k} missing — run the seed first`);
      return r.id;
    };
    const password = `E2e-${randomBytes(9).toString("base64url")}`;
    const hash = await hashPassword(password);
    for (const p of PROJECTS) {
      const admin = `e2e-admin-${p}`; // pending forced password change (phase1.spec)
      const readyAdmin = `e2e-ready-admin-${p}`; // no pending change (admin.spec)
      const teacher = `e2e-teacher-${p}`;
      for (const [username, role, mustChange] of [[admin, "SUPER_ADMIN", true], [readyAdmin, "SUPER_ADMIN", false], [teacher, "TEACHER", false]] as const) {
        const id = `e2e${randomBytes(10).toString("hex")}`;
        await client.query(
          `INSERT INTO "user" (id, username, display_name, password_hash, must_change_password, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [id, username, role === "SUPER_ADMIN" ? "E2E Admin" : "E2E Teacher", hash, mustChange],
        );
        await client.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [id, roleId(role)]);
      }
      creds[p] = { admin, readyAdmin, teacher, password, newPassword: `E2e-new-${randomBytes(9).toString("base64url")}` };
    }
    await client.query(`DELETE FROM rate_limit_bucket`);
  } finally {
    await client.end();
  }
  mkdirSync("playwright/.cache", { recursive: true });
  writeFileSync("playwright/.cache/e2e-credentials.json", JSON.stringify(creds), { encoding: "utf8" });
}
