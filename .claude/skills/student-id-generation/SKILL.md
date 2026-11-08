---
name: student-id-generation
description: Use when generating or formatting any human-facing serial identifier — student ID, admission number, employee code, invoice/receipt/payment/slip numbers — or when touching lib/sequence or ID format settings.
---

# Permanent ID & sequence generation

## Responsibilities
Produce unique, never-reused, never-changing identifiers under concurrency.

## Mechanism
- Table `SequenceCounter(key PK, value Int)`.
- `sequence.next(tx, key)` executes inside the caller's transaction:
  ```sql
  INSERT INTO sequence_counter(key, value) VALUES ($1, 1)
  ON CONFLICT (key) DO UPDATE SET value = sequence_counter.value + 1
  RETURNING value;
  ```
  The row lock serializes concurrent callers; if the outer transaction rolls back, the increment rolls back too (no gaps from failures, no duplicates).
- Formatting with a token template from settings (`SchoolSetting.idFormats`):
  - `{CODE}` school short code · `{YYYY}` admission year · `{YY}` · `{SESSION}` (e.g. 2026-27) · `{CLASS}` · `{SEQ:n}` zero-padded counter.
  - Default student ID: `{CODE}-{YYYY}-{SEQ:4}` → `JNV-2026-0001`.
- Counter key includes every token that should reset it: `student_id:2026`. A format without `{YYYY}` uses key `student_id:all`.

## Rules
- Never compute IDs with `MAX()+1`, `count()`, timestamps or on the client.
- The formatted value is stored in a unique column (`Student.studentCode`) — the DB constraint is the final guard.
- Changing the format in settings affects only future IDs; validate that the new format still contains `{SEQ}` and cannot collide with existing values (reject if the prefix matches an existing format's output space).
- IDs never change on edit, promotion, section change, roll-number regeneration, or re-admission.
- Overflow: if `SEQ:4` exceeds 9999, keep counting (`10000`) rather than wrap — and warn in settings.

## Tests (required)
- 50 concurrent `createAdmission` calls → 50 distinct, consecutive codes.
- Rolled-back transaction does not consume a number.
- Editing a student leaves `studentCode`/`admissionNo` untouched; attempting to set them throws ValidationError.
