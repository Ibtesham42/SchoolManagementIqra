---
name: import-export
description: Use when building or changing bulk import (XLSX/CSV upload, column mapping, validation, preview, confirm, import report) or exports/reports (XLSX/CSV/PDF/JSON) for any module.
---

# Import & export

## Import pipeline (`import.run` + the target module's create permission)
1. **Upload**: XLSX (exceljs, streaming reader) or CSV (papaparse); max 10 MB / 20,000 rows. StoredFile PRIVATE. ImportJob = UPLOADED.
2. **Select module** → load its `ImportDefinition`: target fields, Zod row schema, natural key for duplicates, resolver functions (e.g. class name → classId).
3. **Map columns**: auto-suggest by normalized header; user adjusts; saved mapping templates per module. → MAPPED.
4. **Validate**: parse every row into ImportRow with `errors[]` and status VALID / INVALID / DUPLICATE (natural key exists in DB or earlier in the file). → VALIDATED.
5. **Preview**: paginated rows with errors highlighted; download error report (XLSX with an "errors" column).
6. **Confirm**: process VALID rows in batches of 200, each batch in a transaction, **calling the module's service functions** (so IDs, audits and rules apply — never raw inserts). → IMPORTING → COMPLETED/FAILED.
7. **Report**: counts imported/skipped/failed, link to report file; audit `import.completed`.

Re-running the same file must be idempotent (duplicates detected by natural key, rows already IMPORTED skipped).

## Export (`export.run` + module read permission)
- Each export is a named report definition: query (respecting caller's scope), columns with `sensitive` flags, formats.
- Columns flagged sensitive are omitted unless the caller has the module's `*.sensitive.read`.
- XLSX/CSV: neutralize formula injection (prefix `'` when a cell starts with `= + - @ \t \r`). PDF via report templates with school branding. JSON only for system-level exports (Super Admin).
- Large exports stream; every export is audited (report, filters, row count).

## Modules
Students, Teachers/Employees, Attendance, Fees (structures, payments), Exam marks, Transport, Library, Inventory.

## Tests
Mapping auto-suggest, per-row validation messages, duplicate in-file and in-DB, idempotent rerun, batch rollback on failure, sensitive column redaction, formula injection neutralised.
