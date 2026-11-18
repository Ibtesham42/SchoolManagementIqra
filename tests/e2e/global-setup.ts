import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "dotenv";
import pg from "pg";
import { hashPassword } from "../../src/lib/auth/password";
import { assertRunIdentity, E2E_TARGET, IDENTITY_SQL, resolveRunTarget } from "../../src/lib/db-target-guard";

/**
 * Creates disposable e2e users (one set per browser project) in the development or test database the
 * server under test uses (E2E_DATABASE_URL). Requires the seed to have run (roles exist). Passwords are
 * random per run and written only to playwright/.cache/ (git-ignored).
 *
 * S-06 guard (before any write): E2E_DATABASE_URL (shell) must point at the branch/endpoint allow-listed in
 * E2E_TARGET_BRANCH_ID / E2E_TARGET_ENDPOINT_ID, never at FORBIDDEN_* (production), and the live server must
 * report exactly that identity (read-only check). The accounts are created in ONE transaction that takes the
 * Super Admin guard lock first (ADR-025) and writes an audit row per account; global-teardown removes them.
 */
export const PROJECTS = ["desktop-chrome", "pixel-7", "iphone-14"] as const;
export const E2E_ACTOR_LABEL = "system:e2e-setup";

/** Allow-list and forbidden ids come from .env; E2E_DATABASE_URL (and any override) from the shell. */
export function e2eEnv(): Record<string, string | undefined> {
  const fromFile = existsSync(".env") ? parse(readFileSync(".env")) : {};
  return { ...fromFile, ...process.env };
}

/** Guard + connect; throws (nothing written) unless the target is the allow-listed branch/endpoint. */
export async function connectVerified(env: Record<string, string | undefined>): Promise<pg.Client> {
  const target = resolveRunTarget(env, E2E_TARGET);
  const client = new pg.Client({ connectionString: env.E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query<{ branch: string | null; endpoint: string | null }>(IDENTITY_SQL);
    assertRunIdentity(rows[0], target, E2E_TARGET);
    await client.query("ROLLBACK");
    return client;
  } catch (e) {
    await client.end().catch(() => undefined);
    throw e;
  }
}

export default async function globalSetup() {
  const env = e2eEnv();
  if (!env.E2E_DATABASE_URL) {
    console.log("[e2e] E2E_DATABASE_URL not set — database-dependent specs will be skipped (pending).");
    return;
  }
  const client = await connectVerified(env);
  const creds: Record<string, { admin: string; readyAdmin: string; teacher: string; password: string; newPassword: string }> = {};
  const password = `E2e-${randomBytes(9).toString("base64url")}`;
  const hash = await hashPassword(password); // outside the transaction (Argon2 is slow)
  try {
    await client.query("BEGIN");
    // ADR-025: Super Admin membership changes take the guard lock as the first statement.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('school_erp.super_admin_guard'))`);
    await client.query(`DELETE FROM "user" WHERE username LIKE 'e2e-%'`);
    const roles = await client.query<{ id: string; key: string }>(`SELECT id, key FROM role WHERE key IN ('SUPER_ADMIN','TEACHER')`);
    const roleId = (k: string) => {
      const r = roles.rows.find((x) => x.key === k);
      if (!r) throw new Error(`Role ${k} missing — run the seed first`);
      return r.id;
    };
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
        await client.query(`INSERT INTO audit_log (actor_label, action, entity_type, entity_id, after) VALUES ($1, 'user.create', 'User', $2, $3)`, [
          E2E_ACTOR_LABEL,
          id,
          JSON.stringify({ username, roleKeys: [role], e2e: true }),
        ]);
      }
      creds[p] = { admin, readyAdmin, teacher, password, newPassword: `E2e-new-${randomBytes(9).toString("base64url")}` };
    }
    // Development/test only (guarded above): clears lockouts left by earlier e2e runs.
    await client.query(`DELETE FROM rate_limit_bucket`);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
  mkdirSync("playwright/.cache", { recursive: true });
  writeFileSync("playwright/.cache/e2e-credentials.json", JSON.stringify(creds), { encoding: "utf8" });
}
