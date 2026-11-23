import { rmSync } from "node:fs";
import { connectVerified, E2E_ACTOR_LABEL, e2eEnv } from "./global-setup";
import { removePortalFixtures } from "./portal-fixture";

/**
 * S-06: removes the disposable e2e accounts after the run (same target guard as the setup; one transaction
 * with the Super Admin guard lock first; audited). Their login sessions cascade. The credentials file is
 * deleted. Without E2E_DATABASE_URL nothing was created, so nothing is done.
 */
export default async function globalTeardown() {
  const env = e2eEnv();
  if (!env.E2E_DATABASE_URL) return;
  const client = await connectVerified(env);
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('school_erp.super_admin_guard'))`);
    const { rows } = await client.query<{ id: string }>(`DELETE FROM "user" WHERE username LIKE 'e2e-%' RETURNING id`);
    await client.query(`INSERT INTO audit_log (actor_label, action, entity_type, after) VALUES ($1, 'user.delete', 'User', $2)`, [E2E_ACTOR_LABEL, JSON.stringify({ e2eAccountsRemoved: rows.length })]);
    await client.query("COMMIT");
    // Review 6A-M4 L2: the e2e families go in a SEPARATE transaction after the accounts are gone — a failure here
    // (e.g. someone linked a real account to an e2e guardian) never brings the e2e Super Admin accounts back.
    try {
      await client.query("BEGIN");
      await removePortalFixtures(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("[e2e] portal fixtures not removed:", e instanceof Error ? e.message : "unknown");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
  rmSync("playwright/.cache/e2e-credentials.json", { force: true });
}
