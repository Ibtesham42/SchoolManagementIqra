import { randomBytes, randomInt } from "node:crypto";
import type pg from "pg";
import { formatActivationCode, generateActivationCode, hashActivationCode, UNUSABLE_PASSWORD_HASH } from "../../src/lib/auth/activation-code";

/**
 * Phase 6A-M4 — a synthetic family per browser project for the portal journey (tests/e2e/portal.spec.ts): one academic
 * session "E2E-…", two guardians "E2E Parent …", one child each, and a PARENT account (not activated) for family A
 * with a fresh activation code. Created inside global-setup's guarded transaction (S-06); removed by global-teardown
 * (after the e2e users). Synthetic data only.
 */
export interface PortalFixture {
  username: string;
  /** Formatted activation code (plain text only in playwright/.cache, git-ignored). */
  code: string;
  dob: string;
  childName: string;
  ownStudentId: string;
  otherStudentId: string;
}

const id = () => `e2e${randomBytes(10).toString("hex")}`;
// Clearly synthetic: Indian mobiles start with 6–9 and no STD code starts "10", so "103…" is never a real number.
const phone = () => `103${String(randomInt(0, 1e7)).padStart(7, "0")}`;

export async function createPortalFixture(client: pg.Client, project: string, parentRoleId: string): Promise<PortalFixture> {
  const tag = randomBytes(3).toString("hex").toUpperCase();
  const sessionId = id();
  await client.query(`INSERT INTO academic_session (id, name, start_date, end_date, status, updated_at) VALUES ($1, $2, DATE '2030-04-01', DATE '2031-03-31', 'ACTIVE', now())`, [sessionId, `E2E-${project}-${tag}`]);
  const student = async (first: string, dob: string) => {
    const sid = id();
    const full = `${first} E2E`;
    await client.query(
      `INSERT INTO student (id, student_code, admission_no, first_name, last_name, full_name, full_name_normalized, dob, gender, admission_date, admitted_session_id, updated_at)
       VALUES ($1, $2, $3, $4, 'E2E', $5, $6, $7::date, 'FEMALE', DATE '2030-06-01', $8, now())`,
      [sid, `E2E-${tag}-${first.slice(0, 3).toUpperCase()}`, `E2EADM-${tag}-${first.slice(0, 3).toUpperCase()}`, first, full, full.toLowerCase(), dob, sessionId],
    );
    return sid;
  };
  const guardian = async (name: string) => {
    const gid = id();
    await client.query(`INSERT INTO guardian (id, name, phone, updated_at) VALUES ($1, $2, $3, now())`, [gid, name, phone()]);
    return gid;
  };
  const ownStudentId = await student("Asha", "2016-03-04");
  const otherStudentId = await student("Bela", "2016-07-08");
  const gA = await guardian(`E2E Parent A ${tag}`);
  const gB = await guardian(`E2E Parent B ${tag}`);
  for (const [s, g] of [[ownStudentId, gA], [otherStudentId, gB]]) {
    await client.query(`INSERT INTO student_guardian (student_id, guardian_id, relation, is_primary, is_emergency_contact) VALUES ($1, $2, 'MOTHER', true, true)`, [s, g]);
  }
  const userId = id();
  const username = `e2e-parent-${project}`;
  await client.query(`INSERT INTO "user" (id, username, display_name, password_hash, guardian_id, updated_at) VALUES ($1, $2, $3, $4, $5, now())`, [userId, username, `E2E Parent A ${tag}`, UNUSABLE_PASSWORD_HASH, gA]);
  await client.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [userId, parentRoleId]);
  await client.query(`INSERT INTO audit_log (actor_label, action, entity_type, entity_id, after) VALUES ('system:e2e-setup', 'user.create', 'User', $1, $2)`, [userId, JSON.stringify({ username, roleKeys: ["PARENT"], e2e: true })]);
  const code = generateActivationCode();
  await client.query(`INSERT INTO account_activation (id, user_id, code_hash, channel, expires_at, updated_at) VALUES ($1, $2, $3, 'SLIP', now() + interval '1 day', now())`, [id(), userId, hashActivationCode(code)]);
  return { username, code: formatActivationCode(code), dob: "2016-03-04", childName: "Asha E2E", ownStudentId, otherStudentId };
}

/** Removes every e2e family (call after the e2e users are deleted: user.guardian_id is RESTRICT). */
export async function removePortalFixtures(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM student WHERE admitted_session_id IN (SELECT id FROM academic_session WHERE name LIKE 'E2E-%')`);
  const studentIds = rows.map((r) => r.id);
  const { rows: g } = await client.query<{ guardian_id: string }>(`SELECT DISTINCT guardian_id FROM student_guardian WHERE student_id = ANY($1)`, [studentIds]);
  await client.query(`DELETE FROM student_guardian WHERE student_id = ANY($1)`, [studentIds]);
  await client.query(`DELETE FROM guardian WHERE id = ANY($1) AND name LIKE 'E2E Parent %'`, [g.map((r) => r.guardian_id)]);
  await client.query(`DELETE FROM student WHERE id = ANY($1)`, [studentIds]);
  await client.query(`DELETE FROM academic_session WHERE name LIKE 'E2E-%'`);
  return studentIds.length;
}
