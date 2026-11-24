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
  "account_activation", // → user (Phase 6A migration 20261126000000)
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
  // user.employee_id → employee, user.student_id → student, user.guardian_id → guardian point backwards
  // (see DEFERRED_FK_COLUMNS).
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
  // Phase 3C payroll — migration 20261120000000 (applied to development 2026-11-19; Test pending KI-059).
  "salary_component",
  "salary_structure",
  "salary_structure_item", // → salary_structure, salary_component
  "employee_salary", // → employee, salary_structure, user
  "payroll_run", // → user
  "payroll_slip", // → payroll_run, employee, employee_salary
  "payroll_adjustment", // → payroll_slip, user
  "salary_payment", // → payroll_slip, user
  // Phase 4A teaching structure & student attendance — migration 20261121000000 (applied to development 2026-11-19; Test pending KI-059).
  "subject",
  "class_subject", // → academic_session, school_class, subject
  "student_subject", // → academic_session, student_enrollment, class_subject
  "teacher_allocation", // → academic_session, section, class_subject, employee
  "period", // → academic_session
  "timetable_slot", // → academic_session, section, period, class_subject, employee
  "student_attendance", // → academic_session, student_enrollment, user
  // Phase 4B examinations — migration 20261122000000 (DRAFT: awaiting SQL approval).
  "grade_scale",
  "grade_band", // → grade_scale
  "examination", // → academic_session, grade_scale, user
  "exam_subject", // → academic_session, examination, class_subject
  "marks_sheet", // → academic_session, exam_subject, section, user
  "examination_marks", // → academic_session, marks_sheet, student_enrollment, user
  "report_card", // → academic_session, examination, student_enrollment, generated_document
  // Phase 4C promotion, homework, calendar — migration 20261123000000 (DRAFT: awaiting SQL approval).
  "promotion_decision", // → academic_session, student_enrollment, school_class, user
  "homework", // → academic_session, section, class_subject, user
  "academic_event", // → academic_session
  // Phase 5A fees — migration 20261124000000 (applied to development and Test 2026-11-20).
  "fee_category",
  "fee_installment", // → academic_session
  "fee_structure", // → academic_session, school_class
  "fee_structure_item", // → fee_structure, fee_category, fee_installment
  "fee_concession",
  "fee_concession_category", // → fee_concession, fee_category
  "student_concession", // → student_enrollment, fee_concession, user
  "late_fee_rule", // → academic_session
  "student_fee_charge", // → student_enrollment, fee_installment, fee_category, user
  "fee_invoice", // → student_enrollment, fee_installment, user
  "fee_payment", // → student, user (before fee_invoice_item since Phase 6A: KI-105 links point at it)
  "fee_invoice_item", // → fee_invoice, fee_category, student_fee_charge, fee_payment (waived with / frozen by), user
  "fee_payment_allocation", // → fee_payment, fee_invoice_item, fee_invoice
  "fee_payment_claim", // → student, fee_payment, user (Phase 6C-M3 migration 20261128000000, SQL approved 2026-11-24; not applied yet)
  // Phase 6C notices — migration 20261127000000 (SQL approved 2026-11-24; not applied yet).
  "notice", // → academic_session, stored_file, user
  "notice_target", // → notice, school_class, section
  "notice_read", // → notice, user
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
  user: ["employee_id", "student_id", "guardian_id"], // Phase 3A / Phase 6A portal links
};
