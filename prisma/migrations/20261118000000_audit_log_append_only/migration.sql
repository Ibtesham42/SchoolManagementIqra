-- S-07 (SECURITY_AUDIT_2026-11-10_PHASE_2B.md Appendix B; owner approved creating it for review 2026-11-18):
-- database-level append-only audit_log. Every UPDATE, DELETE or TRUNCATE of audit_log raises an error while the
-- triggers are enabled; INSERT and SELECT are unaffected. Application code never updates or deletes audit rows,
-- the backup drill only inserts, and test cleanups keep audit rows.
-- Limits: the app connects as the database owner, who can still DROP or DISABLE the triggers — this protects
-- against bugs and casual misuse, not a full SQL compromise; full protection needs KI-024's least-privilege
-- runtime role (Phase 10). Future DPDP retention/erasure: an owner-run, audited maintenance procedure that
-- disables the trigger inside one transaction — never an application code path.
-- Prisma does not model triggers → no schema change, no drift.
-- Review status: CREATED FOR REVIEW 2026-11-18 — NOT APPLIED. Applying to development / Test needs the owner's
-- separate approval per branch; never production without explicit approval.
--
-- Rollback (comment only — owner-approved, development/Test only):
--   DROP TRIGGER audit_log_no_truncate ON audit_log;
--   DROP TRIGGER audit_log_no_update_delete ON audit_log;
--   DROP FUNCTION audit_log_append_only();
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118000000_audit_log_append_only';

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

COMMIT;
