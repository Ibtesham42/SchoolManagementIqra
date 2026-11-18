/**
 * Every application table, parents before children (foreign-key order), shared by `db:check` and
 * the backup drill. `tests/unit/db-tables.test.ts` fails if this list misses a table from
 * prisma/schema.prisma or breaks a foreign key's order — so a new table can never be silently left
 * out of verification or backups.
 */
export const APP_TABLES_IN_FK_ORDER = [
  "role",
  "permission",
  "role_permission",
  "academic_session",
  "user",
  "user_role",
  "session",
  "password_reset_token",
  "stored_file", // → user
  "school_setting", // → stored_file (logo), academic_session
  "school_class", // migration 20261110000000
  "section", // → academic_session, school_class, user (class teacher)
  "generated_document", // → stored_file, user
  // Phase 2b admissions & students — migration 20261111000000 (applied to development and Test).
  "student", // → academic_session
  "guardian",
  "admission_application", // → academic_session, school_class, section, student, user
  "admission_guardian", // → admission_application, guardian
  "student_guardian", // → student, guardian
  "student_document", // → admission_application, student, stored_file, user
  "student_enrollment", // → student, academic_session, section
  "roll_number_batch", // → section, user
  "student_roll_number", // → roll_number_batch, student_enrollment
  "student_status_change", // → student, user
  // Phase 3A HR core — migration 20261112000000 (applied to development and Test 2026-11-18).
  // user.employee_id → employee points backwards (see DEFERRED_FK_COLUMNS).
  "department",
  "designation",
  "employee", // → department, designation, employee (reports to), user (created by)
  "teacher_profile", // → employee
  "employee_document", // → employee, stored_file, user
  "employee_service_event", // → employee, user
  // Phase 3B attendance & leave — migration 20261119000000 (applied to development and Test 2026-11-18).
  "leave_type",
  "leave_balance", // → employee, leave_type, academic_session
  "leave_request", // → employee, leave_type, academic_session, user
  "employee_attendance", // → employee, leave_request, user
  "holiday", // → user
  "attendance_period_lock", // → user
  "audit_log",
  "notification",
  "sequence_counter",
  "rate_limit_bucket",
  "usage_counter",
] as const;

/**
 * Foreign-key columns that point BACKWARDS in APP_TABLES_IN_FK_ORDER — the only cycle in the schema:
 * "user"."employee_id" → employee, while employee.created_by_id (and other actor columns) → "user".
 * No table order satisfies both, so a restore inserts these columns as NULL and sets them once every
 * table is loaded (same transaction). `tests/unit/db-tables.test.ts` fails if any other backward FK
 * appears, or if a column listed here stops being a backward FK.
 */
export const DEFERRED_FK_COLUMNS: Readonly<Partial<Record<(typeof APP_TABLES_IN_FK_ORDER)[number], readonly string[]>>> = {
  user: ["employee_id"],
};
