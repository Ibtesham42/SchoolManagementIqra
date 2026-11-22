# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow SemVer once the first release ships.

## [Unreleased]

### Added (Phase 5C — fee reports)
- **Previous dues** (Fees → Previous dues): bring in each student's unpaid fees from the old system, one class at a time — download the template, fill in the amounts, upload, check the preview, choose the due date and confirm. Each student gets one "Previous dues" invoice; running it again skips students who already have one.
- **Reconciliation** (Fees → Reports → Reconciliation checks): one button checks that every receipt matches what it paid, every invoice matches its lines, the collection totals match the money on invoices, and receipt and invoice numbers have no gaps. Problems are listed by receipt or invoice number.
- **Reports** (Fees → Reports): money collected by day, payment method, collector or fee head; what is still due by class and section or by installment; defaulters with how long they are overdue and the primary guardian's name and phone; the concession register (who proposed and who approved, plus late-fee waivers); cancelled receipts; and cancelled invoices that were never issued again. Every report can be exported as a CSV file (staff with export rights); guardian phone numbers are left out of downloads unless you may also export student records.

### Fixed
- Searching for a student at the fee counter with a % or _ in the name now works.

### Added (Phase 5B — fee collection at the counter)
- **Printable receipts**: every receipt can be printed as a PDF with the school letterhead, the amount in figures and words and what it paid for. The accountant's first print is the original; later prints are marked DUPLICATE, other staff see an office copy, and cancelled receipts are marked CANCELLED.
- **Receipts** (Fees → Receipts): every receipt, newest first, and a lookup by receipt number. A receipt can be **cancelled** with a reason (bounced cheque, wrong student, entered twice) by someone allowed to cancel receipts — never the person who collected it. The accountant can cancel only receipts recorded the same day; older ones need the Principal, and receipts of a closed session need the Super Admin. The receipt keeps its number and is marked cancelled, the amount becomes due again on its invoices, and its UPI / bank / cheque reference can be used again. A late fee fixed by the cancelled payment stays on the invoice.
- **Collect** (Fees → Collect): find a student (from any session, so earlier dues can be collected), see what is due today oldest first with today's late fees, and record a payment by cash, UPI, bank transfer, cheque or card. The payment goes to the oldest dues first (or the invoices you choose), the late fee is fixed on the invoice when paid, and a receipt number is given. Submitting the same form twice gives one receipt; the counter also lists the student's receipts of the last 24 hours. Payment dates can go back at most 7 days. Late fees can be waived (with a reason) by staff allowed to give concessions.

### Added (Phase 5A — invoices)
- **Invoices** (Fees → Invoices): choose a class and an installment, check the preview (who is billed, how much, who is skipped and why), then issue the invoices in one step. They are numbered from the school's invoice format, include approved concessions and extra charges, and running it again only adds students who don't have the invoice yet. An unpaid invoice can be cancelled with a reason and issued again.
- Approving or revoking a concession updates the student's unpaid invoices straight away.
- **Student fee page**: every invoice of a student across sessions, with its lines, concessions and the balance due.

### Added (Phase 5A — concessions and extra charges)
- **Concessions** (Fees → Concessions): the school's concessions and scholarships, as a percentage or a fixed amount on every installment, on chosen fee heads. The accountant proposes one for a student with a reason; the Principal (or another person with approval rights) approves or rejects it — nobody decides their own proposal. Each proposal shows its effect for the whole session. Approved concessions can be revoked for future invoices.
- **Extra charges** (Fees → Extra charges): one-off charges for one student on one installment (hostel, an activity, a bounced-cheque charge), added to that installment's invoice.

### Added (Phase 5A — fee setup)
- New **Fees** menu (Accountant sets up; School Admin, Principal and Vice Principal can view):
  - **Fee heads**: the school's own fee names (tuition, admission, lab…), with who pays each (everyone, new admissions only, or existing students only). Nothing is pre-filled.
  - **Receipt and invoice number formats**, e.g. `RCT/{YYYY}/{SEQ:5}`; invoices and receipts can't be issued until both are saved.
  - **Installments** per academic session (monthly, quarterly or terms, with due dates) and the session's **late fee** (a fixed amount, an amount per day with a maximum, or a percentage), with a grace period.
  - **Class fees**: what each class pays per fee head and installment. One structure is active per class; once invoices are issued its amounts are fixed, and changes are made on a copy that is then made active.
- Parents and students don't see fees yet; that comes with the portal.

### Added (Phase 4C — homework attachments)
- Teachers can **attach a file to homework** (a worksheet or handout: PDF, JPEG or PNG, up to 10 MB), replace it or remove it. Staff who can see the homework can download it. Files are stored privately and encrypted; photos are saved without their location data.

### Added (Phase 4C — marks import)
- **Import marks from a spreadsheet** (on each marks sheet): download the template (Excel or CSV) with the sheet's students and any saved marks, fill it in (AB = absent, EX = exempt; a blank cell keeps the saved mark), upload it, check the preview and confirm. Nothing is imported while any row has a problem, and the same rules apply as on the entry grid.

### Added (Phase 4C — promotion, homework, academic calendar; needs migration 20261123000000, not yet applied)
- **Promotion** (Academic → Promotion): at session end the class teacher marks each student Promote, Detain or Leave (transferred / withdrawn / graduated); for classes with streams the next class is chosen, never guessed. From the session's last day the School Admin confirms a section in one step: promoted and detained students get their enrollment in the next session's chosen section (section capacity checked), this session's enrollments are closed on its last day, and leavers get their new status recorded. Roll numbers are then generated in the new sections as usual.
- **Homework** (Academic → Homework): teachers post homework (title, what to do, due date) for the subjects they teach in each section; the School Admin for any section; class teachers see all of their section's homework. Text only for now — attachments come next.
- **Academic calendar** (Academic → Calendar): one month at a time — student holidays, exam periods and paper dates, and the school's own events, which the school office adds and edits. Separate from the public website's events.
- New permission **Post and manage homework** (`homework.manage`) for Teacher, Class Teacher (their own subjects) and School Admin.
- Every Academic screen now shows the same set of tabs for the user's role.

### Added (Phase 4B — examinations and results; needs migration 20261122000000, not yet applied)
- **Exams** (Academic → Exams; School Admin and Principal): create an exam in a session with its own grading scale and optional dates, add class subjects with maximum marks per part (theory / practical / internal; 0 = not examined) and an optional pass mark, then Draft → Scheduled (the scale's bands freeze) → Marks entry. Draft exams can be deleted.
- **Marks entry** (Academic → Marks): a teacher sees only the subjects they are allocated to teach in each section and enters marks on one phone screen — whole or half marks, AB (absent, counts 0) or EX (exempt, left out of the total). Work can be saved part-done, then submitted.
- **Approval** (Principal, Vice Principal): approve or return submitted marks; nobody approves marks they entered or submitted. Approved marks can be corrected by an approver with a reason until results are published. **Lock marks** once every sheet is approved; reopen if needed before publication.
- **Results**: a live preview per section while marks are entered; **Publish results** (Principal, Vice Principal) creates a fixed report card for every enrolled student — subject marks and grades, total, percentage, overall grade, pass / not passed, attendance % and, if the school turns it on (Settings → Results: rank in class), the rank in class. Class teachers add a remark and download the **report card PDF** for their own section; School Admin and Principal for every section.

### Added (Phase 3C — payroll, in progress)
- **Payroll** (new menu item for HR Manager, Accountant, Principal and Super Admin): **salary components** — the school's own earnings and deductions, a fixed amount or a percentage of basic, reduced for unpaid days or not — and **salary structures** that group them with amounts. Nothing is pre-filled and nothing is calculated by law automatically. HR Manager edits; the Principal and Accountant view.
- **Employee salaries** (Payroll → Employee salaries): HR proposes an employee's basic and structure from a month; the Principal approves or rejects (with a reason). Nobody proposes or approves their own salary, and the approver can't be the proposer. Approved salaries are never edited — a change is a new proposal — and months whose payroll is approved can't be changed. Amounts never appear in the audit log.
- Salary structures that approved or pending salaries use can't have their components changed (that would change approved pay without approval). Use **Copy** to make a new version, then propose new salaries.
- **Monthly payroll** (Payroll → Monthly payroll): create a month's payroll and prepare it after the month ends — every slip is calculated from the approved salary and the month's attendance (paid / unpaid leave, absences, half days, joiners and leavers). It won't run while anyone's attendance has unmarked days, and lists staff without an approved salary instead of paying them. Prepare again any time before approval.
- **Payroll approval**: the Principal approves a prepared payroll (never the person who prepared it, and never a payroll that includes their own slip). Approval re-checks every slip and refuses if attendance or salaries changed since preparing, numbers the salary slips and locks the month's staff attendance. It can be reopened with a reason until a payment is recorded; slip numbers stay the same.
- **Salary slips and payments**: each slip shows earnings, deductions, bonus / arrears and paid days. Before approval, HR or the Accountant can add a bonus, arrears or a one-off deduction (it applies when the payroll is prepared again). After approval, the Accountant records payments — per slip or all unpaid slips at once — never more than is due; the payroll shows as paid when everything is paid. Nobody adjusts or records a payment of their own salary.
- **PAN and bank details** on the employee profile (HR Manager): stored encrypted, always shown masked (e.g. XXXXXX234F). Nobody changes their own; the same PAN can't be recorded twice.
- **Grading scales** (Academic → Grading): define how percentages become grades, or start from a CBSE-style 8-point template and edit it. A scale's bands are fixed once an exam uses it. *(Needs the Phase 4B database update — not applied yet.)*
- **Payroll reports**: totals by component on each monthly payroll, and the payroll register as a CSV (Accountant, HR Manager) — paid days, gross, deductions, net, paid and due per slip. No PAN or bank details.
- **Salary slip PDF**: "Download PDF" on an approved slip — the school letterhead with earnings, deductions, paid days and net pay.
- **My salary slips** (new menu item for staff): your own slips from approved payrolls.
- **Payroll basis** (Settings): prorate pay on working days or calendar days. Not set by default — payroll asks you to choose.

### Added (Phase 4 — academic management, in progress)
- **Subjects** (Classes → Subjects; School Admin and Super Admin edit, school-wide academic readers view): the subjects the school teaches, in any language, scholastic or co-scholastic. Nothing is pre-filled. Code and type are fixed once a class studies the subject; subjects are never deleted, only deactivated.
- **Class subjects** (Classes → Class subjects): for each session and class, the subjects it studies — compulsory or optional — in report-card order. Copy last session's plan in one step. Closed sessions are read-only; a subject in use can't be removed.
- **Subject teachers** (Classes → Teachers): for each section, who teaches each subject. Only active teaching staff with a linked login can be chosen; one teacher per subject per section. A teacher still named in the timetable can't be changed or removed until the timetable is updated.
- **Optional subjects** (Classes → Optional subjects): tick which students of a section take each optional subject. If someone else saved the same subject in the meantime, your save is refused with a "reload" message instead of overwriting theirs.
- **Timetable** (Classes → Timetable): the bell schedule per weekday (lessons and breaks, copy one day to others) and each section's week, set period by period on a phone. The teacher of a lesson is the subject's allocated teacher; a teacher can't be booked in two sections in the same period. Teachers see **My timetable**.
- **Student attendance** (Classes → Attendance): the class teacher marks the day on one phone screen — everyone present by default, tap absent, late, half day or excused, save once. The same day, the class teacher may change a mark; later the school office corrects it with a reason. No marks on weekly offs, student holidays or future dates. A month register shows each student's counts and attendance %.
- **Student weekly off** (Settings): days without school for students, separate from the staff weekly off.

### Added (Phase 3B — attendance & leave, in progress)
- Leave types (Staff → Leave types; School Admin and HR Manager): the school's own leave types with a quota per academic session, paid or unpaid, half days, carry-forward limit and who can use it (all, teaching or non-teaching staff). Deactivate instead of delete; once a type is in use its code, paid setting and staff group are fixed.
- Holidays (Staff → Holidays): the school calendar per academic session — for everyone, staff only or students only. A holiday can't be added or removed on a date that pending or approved leave already covers.
- Staff weekly off (Settings): for example Sunday plus the 2nd and 4th Saturday. Not set by default — every day counts as a working day until the school sets it.
- Leave balances on the employee page (current academic session): available, used and carried-forward days; HR sets or corrects opening balances. Nobody except a Super Admin can set their own balance, and an administrator's login must be linked to their staff record first.
- `db:check` verifies the 20 Phase 3B constraints.
- Leave (new menu item for staff with leave permissions): **My leave** — your balances for the current session, apply for leave (working days are counted for you; weekly offs and staff holidays don't count; half days where the leave type allows), your requests with the approver's note, and withdraw a pending request. Paid leave can't exceed what is left (apply the rest as unpaid leave); overlapping requests are refused.
- **Leave approvals** (Principal, Vice Principal, HR Manager, Super Admin): pending, approved, rejected and cancelled requests from other staff — those who report to you first. Approving deducts the balance and marks the days as on leave in attendance; rejecting needs a note. Nobody can decide their own leave. Approved leave can be cancelled before its first day (the days return to the balance). Months locked for payroll can't change.

- **Staff attendance** (new menu item, 3B-M4): **Mark a day** (HR Manager, Super Admin) — pick a date and optionally a department; everyone starts as present, tap absent / late / half day, optional check-in and check-out times, save once. Weekly offs, staff holidays, future dates, closed sessions and months locked for payroll can't be marked; days on approved leave are shown but not editable; nobody marks their own attendance. Changing a saved mark needs a reason (kept on the record, not in the audit log).
- **Monthly register** (School Admin, Principal, Vice Principal, HR Manager, Super Admin): per employee — working days so far, present, late, half day, leave, half-day leave, absent, not marked; table on wide screens, cards on phones. Each employee's month opens as a calendar with the day list; markers can mark or correct a day from there.
- **Payroll summary** (Staff attendance → Payroll summary; School Admin, Principal, Vice Principal, HR Manager, Accountant, Super Admin; 3B-M5): per employee for a whole month — working days, weekly offs, holidays, present, late, half days, paid leave, unpaid leave, absent, not marked and **LOP days** (absent + unpaid leave + half a day per half day without leave). Unmarked days are never guessed: the employee shows "Needs review" until the month is over and every working day is marked. **Download CSV** for staff with the export permission (HR Manager, Accountant, School Admin, Super Admin), recorded in the audit log.
- **My attendance** (all staff whose login is linked to their staff record): your own month as a calendar with the same counts. Permissions: staff roles can read their own attendance — catalog 84 permissions, 297 default grants (to be applied to existing databases with approval).

### Added (Phase 3A — HR core, in progress)
- Database migration `20261112000000_phase3a_hr_core` (applied to the development and Test databases 2026-11-18): departments, designations, employees with a permanent employee code, teacher profiles, employee documents (one current photo) and append-only service history; a login account can be linked to one employee. Department and designation names accept any script (Hindi, Khasi, other Indian languages and English). No Aadhaar, PAN, bank or medical data is stored.
- The database check (`db:check`) also verifies the HR constraints once the migration is applied; the backup drill restores linked staff accounts correctly.
- Staff (new menu item for School Admin, Principal, Vice Principal, HR Manager and Librarian): staff directory with status counts, search by name, employee ID or phone, and filters (staff type, department, designation, status, appointment type); table on desktop, cards on phones.
- Register employee (School Admin, HR Manager): four steps — personal, contact, employment, review. The permanent employee ID (`EMP-2026-0001`, joining year) is assigned on registration and never changes; teaching or non-teaching comes from the designation.
- Employee profile with an overview for everyone who may see the directory; date of birth, personal contact details, home address, emergency contact and employment dates only for School Admin, Principal, HR Manager and Super Admin (the Librarian and Vice Principal see the directory only). Personal and contact details can be edited.
- Departments and designations (names in any language, e.g. Hindi or Khasi): add, edit, deactivate — never deleted.
- Teacher profile on a teaching employee's page: academic and professional qualifications (up to 10 each), subjects taught (up to 10, any language), experience before joining and registration number.
- Login account panel on the employee page: shows the linked account; a Super Admin can link an existing active account to the employee or unlink it (one account per employee, recorded in the audit log). Linking lets that person see their own staff record (below).
- "My profile" on My account: staff whose login is linked to their staff record can view it read-only — employment, contact details and qualifications. Parents and students have no access to staff records.
- Class teachers: a teacher can be made class teacher only when their login is linked to an active teaching staff record; the teacher list on the Sections page shows only those teachers. Existing class-teacher assignments are not changed.
- Account linking: only an administrator who can see staff personal details may link accounts, and nobody except a Super Admin can link their own account.
- Permissions: staff roles can now read their own staff record. Catalog: 84 permissions, 291 default grants.
- Employment changes (department, designation, appointment type, confirmation), reporting line (no loops) and status — resigned, terminated, retired, long-term leave, rejoined — each recorded with its date in the employee's service history, shown on the profile to staff who may see personal details (and to the employee on My profile).
- Staff documents and photo on the employee profile (School Admin, HR Manager): upload PDF, JPEG or PNG up to 10 MB (résumé, certificates, appointment / experience / relieving letters, other), view, verify and remove; one current photo (cropped, location and other hidden data removed). Documents are visible to staff who may see personal details and to the employee on My profile; the photo to everyone who may see the staff directory. Removed files are deleted for good after 30 days. No Aadhaar or PAN copies.
- Staff overview (`/erp/hr`): current teaching and non-teaching staff, long-term leave and former staff, staff per department and per status; recent joiners and leavers (for staff who may see personal details); current staff without a login and teachers without a class-teacher section this session (for administrators who can see accounts and classes).
- Download the staff directory as CSV (School Admin, HR Manager, Super Admin) with the current filters — directory columns only, at most 5,000 rows, recorded in the audit log.
- Leaving releases the person's class-teacher sections and offers to deactivate their login (an administrator who manages users can do it in the same step; otherwise the screen says it still has to be done). Rejoining keeps the same employee ID. Nobody except a Super Admin can change their own employment record once their login is linked to their staff record, or unlink their own login.
- Permissions: new "View employee personal details and documents" and "Upload, verify and remove employee documents and photos"; School Admin can now manage staff records. Catalog: 84 permissions, 279 default grants.

### Security (owner decisions 2026-11-18)
- Claude Code may no longer display the secret environment files with shell commands (deny list extended).
- Prepared, not yet applied: the audit log becomes append-only in the database; deleted private files are purged 30 days after removal (metadata kept), with a dry-run-first maintenance job.

### Changed (owner decisions 2026-11-18)
- Photos and scans uploaded as documents (JPEG/PNG) are saved without hidden data such as the location where they were taken. PDFs are stored as uploaded.
- Administrators must have their own login linked to their staff record before changing employment records or verifying documents (a Super Admin links it on the staff profile). This makes sure nobody changes their own record.

### Fixed (CI)
- Five storage modules were missing from the repository because an ignore rule for local file storage also matched the source folder; CI now builds from a clean checkout again.

### Added (Phase 2B — admissions & students, in progress)
- Database (development only): migration `20261111000000_phase2b_admissions_students` — admission applications, applicant guardians, students, guardians, documents, session enrollments, roll-number batches, status history; `school_setting.required_admission_documents` (default photo + birth certificate).
- Admissions screens: application list with status counts and filters, new admission (5 steps, saved as a draft after step 1), application review (start review, assign section, return to draft, reject). Submitting assigns `APP-<session>-<number>` and flags possible duplicate students. Approval and documents follow in the next slices.
- Admission documents and the student photo (step 5 "Photo & documents"): private, encrypted uploads up to 10 MB through a dedicated, same-origin, rate-limited upload route; photos re-encoded by `sharp` (location and other hidden data removed); view, verify and remove with an audit trail. `sharp` 0.35.5 is now a direct dependency.
- Admission approval registers the student in one step: permanent student ID and admission number (session start year), parents/guardians (an existing guardian is linked only when the approver explicitly confirms the same phone number), enrolment in the chosen section with an exact capacity check, and a full audit trail. Possible duplicates need a written reason.
- Database transactions wait up to 10 s for a connection and may run up to 15 s; when the system is busy, users see "The system is busy. Please try again" instead of an error.
- Roll numbers per section (`/erp/students/registration`): alphabetical preview, draft, type-to-confirm finalization; finalized numbers never change automatically — students approved later get the next number; Principal corrections need a reason. New menu item "Roll numbers".
- Students (`/erp/students`): directory with status counts, search by name / student ID / admission number, filters (session — current by default — class, section, status), table on desktop and cards on phones; a class teacher sees only the students of their own section. Student profile (photo, overview, guardians, academic history per session, documents for permitted roles, status history, link to the admission). Edit student details (class teachers: contact details only; student ID and admission number never change) and guardian contact details. "Record leaving" (transferred, withdrawn, graduated) with a date and reason — the student leaves the class, keeps the roll number, and the history is kept. CSV export of the filtered list for School Admin / Super Admin (spreadsheet-safe, at most 5,000 rows, audited, rate limited). New menu item "Students"; the menu now highlights only the most specific item.
- Permission `student.document.manage` (School Admin, Admission Officer); Principal now approves admissions (`admission.approve`) together with School Admin. Catalog: 82 permissions, 271 default grants.

### Security (Phase 2B closure audit, 2026-11-10)
- Document uploads: people who may not upload are refused before the server reads anything; an upload must finish within 2 minutes.
- A class teacher's access to a section's students ends when the session is closed, and when their teacher role is removed; class teachers can now be removed from closed sessions.
- Sign-in limits can no longer be used to keep someone out from another computer; an admin unlock (or a password reset) also clears them.
- The public file address is rate limited and no longer queries the database for every unknown address; private PDFs open as safe downloads.
- Integration and end-to-end tests refuse to write to any database except the explicitly named test branch.
- The role editor only offers scopes the system actually enforces; "own salary" can only be granted for the person's own record.
- CSV export: spreadsheet formulas are also neutralised for semicolon-separated spreadsheets and other edge cases; the export log no longer stores search text.
- Roll-number sheets require permission to read student records.
- Class teachers can't change a parent's details when the parent is also linked to a student in another section (School Admin can).
- The person who created an admission application can no longer approve it; another School Admin or the Principal must.

### Fixed
- ERP pages for a record that doesn't exist (or that the user may not see) now return a real "404 Not Found" status instead of 200. The page content was already the "Page not found" screen; no data was ever shown. The generic loading skeleton during ERP navigation was removed to make this possible.

### Verified (Phase 2B — Neon Test branch, 2026-11-10)
- Test branch migrated (`20261110000000`, `20261111000000`); all Phase 2 and Phase 2B integration suites pass there.
- 50 simultaneous admission approvals pass (179.6 s on the Test branch): 50 distinct student IDs and admission numbers, exact section capacity, no partial registrations. The test now prepares its applications separately, waits for all approvals before cleanup and cleans up by session; admission-approval suite 7 passed, 0 failed.
- Synthetic leftovers of an earlier failed test run removed from the Test branch (25 rows, one transaction, audited). No Development or Production changes.
- Signed-in browser verification of the Students screens is still pending.

### Added (Phase 2 Classes & Sections — offline; migration `20261110000000` NOT applied)
- Classes screen (`/erp/academic/classes`): create, edit, activate/deactivate (never deleted); class code fixed once sections exist; optional per-class default capacity.
- Sections screen (`/erp/academic/sections?session=`): per-session list grouped by class; add several sections at once ("A, B, C, D"); edit name/capacity; activate/deactivate; delete while unused; assign/remove class teacher; copy from another session (no class teachers, idempotent); CLOSED sessions read-only.
- "Default section capacity" (40) on the Settings page; "Classes" menu item (`academic.read` or `academic.manage`).
- `src/modules/academic/`: schemas, pure rules, scope policy, classes and sections services (row locks, optimistic `version`, audit in the same transaction).
- New permission `academic.read` (81 permissions, 267 default grants): ALL for School Admin, Principal, Vice Principal, Admission Officer; ASSIGNED for Teacher / Class Teacher.
- `isUniqueViolationOf` (`lib/db-errors`) maps composite and partial unique-index violations by index name or exact column set.
- `db:check` verifies the classes/sections CHECKs, RESTRICT foreign keys and the partial class-teacher index once the migration is applied.

### Changed (Phase 2 Classes & Sections)
- Seed core: a permission created in a seed run also gets its catalog default grants on existing roles (otherwise `academic.read` would reach Super Admin only on an existing database). Existing grants are still never changed; audited as `newPermissionGrantsCreated`.

### Added (Phase 2a — offline, DB verification pending)
- School settings screen (`/erp/settings`): profile, regional time zone, timings, logo upload/remove, PDF letterhead preview.
- Academic sessions screen (`/erp/settings/sessions`): create, edit planned, activate, make current, close — no overlaps, audited.
- Private/public file storage layer (`lib/storage`) with magic-byte validation, random keys, encryption for private files and an authorized download route (`GET /api/v1/files/:id`).
- PDF generation (`@react-pdf/renderer` 4.9.0) with a shared branded A4 letterhead (`GET /api/v1/documents/preview`).
- "Settings" navigation item; mobile "More" menu when the bottom bar would overflow.

### Added (Phase 2a schema — prepared, not applied)
- Migration `20261109000000_phase2a_files_documents_settings` (awaiting approval): file purpose & ownership, regional settings, logo foreign key, issued-document registry with hashed verification codes.
- Ownership-bound private file access; generated-document issue/verify/revoke services.
- School Admin may manage school settings and academic sessions.
- New permission `document.revoke` (Super Admin, Principal); revoking an issued document no longer follows from `document.generate`.
- `DOCUMENT_VERIFICATION_KEY` (+ `_VERSION`, `_V<n>` for rotation) — required; documents record which key version hashed their code.
- ADR-030: one school per installation.

### Changed (Phase 2a)
- Final review fixes: canonical rotated-key names (`DOCUMENT_VERIFICATION_KEY_V<n>`, no leading zeros); shared-cache headers only for anonymously readable files; private storage root may not be inside `public/` or `.next/`; migration guard also checks `school_setting` ids; `env:check` validates rotated keys.
- Pending migration revised: transactional, pre-flight guard, legacy files owned by `LegacyFile`, all CHECKs fully validated, private ⇒ encrypted.

### Fixed (Phase 2a)
- G7 B3 (KI-050): the PDF letterhead footer ("Generated …" in the school time zone, "Page X of Y") is printed inside every A4 page again; it was drawn ~6200 pt below the page because `lineHeight` was set on `<Page>`. Body line spacing unchanged (14.7 pt).
- G7 B4 (KI-051): the document preview text reads "Settings > School profile"; the "→" glyph does not exist in the built-in PDF font and printed as "'". Templates are now tested to contain only WinAnsi characters.
- G7 B5 (KI-052): after a forced password change the ERP menu now shows the user's real permissions immediately (the layout is re-rendered); before, only Dashboard and My account appeared until a full reload.
- G7 B1 (KI-049): the settings time zone dropdown now always shows the stored zone (legacy ICU names such as `Asia/Calcutta` map to `Asia/Kolkata`); previously it pre-selected `Africa/Abidjan`. Legacy names are stored in their current spelling; unknown values are rejected.
- G7 B2 (KI-048): logos over 800 KB are rejected in the browser with the server's message before upload, instead of hitting Next.js's 1 MB server-action body limit and the generic error page.
- KI-032: ERP dates now use the school's configured time zone; date-only values no longer shift a day.
- File-store backup: the manifest (format 2) no longer contains plaintext content hashes of private files; verification still decrypts each private file and compares it with the database hash. Backup docs list every key needed for recovery, the recovery sequence, and that database and file backups are not atomic (KI-047).
- Backup drill: `date`/`timestamp` columns no longer shift in the JSON round-trip on a machine outside UTC (drill sessions use UTC/ISO and read date/time values as text; JS Dates are refused). The write check now requires the new `audit_log` id to exceed the restored maximum. G6-A checklist documents the point-in-time child branch method (schema-only branches are refused by `drill:env`).

### Added (Neon setup guide)
- docs/NEON_SETUP_GUIDE.md — verified owner procedure for Neon development/test branches, local env files, keys, `env:check` and migration review (test branch via `DOTENV_PATH` inside `try/finally`).

### Added (UI audit & roadmap)
- docs/LOCAL_UI_AUDIT.md, docs/DEVELOPMENT_ROADMAP.md (phases 0–10); styled 404 page; ERP loading skeleton; `lib/format.ts` (school time zone).
- Claude Code: devops-ci-engineer and documentation-manager agents; 10 new skills; shared agent guardrails.

### Fixed
- Tablets got 36 px controls (compact sizes now require a fine pointer).
- Dates rendered in the server's time zone.
- Stale/incorrect instructions in `.claude/` rules, agents and skills.

### Added (CI)
- GitHub Actions CI (`.github/workflows/ci.yml`): typecheck, lint, architecture check, unit tests, production dependency audit and production build on Node 26 / Ubuntu, read-only, no secrets or database.

### Security (offline audit, 2026-11-08 — see SECURITY.md A1–A20)
- Delegated admins can no longer modify (reset, deactivate, edit, sign out) users more privileged than themselves.
- Super Admin membership changes serialized with a transaction-scoped advisory lock (fixes a race that could leave zero Super Admins).
- Unsafe raw-SQL lint rule fixed (it never matched); layer-boundary lint rules and `npm run check:deps` added.
- Sessions: renewal no longer extends lifetime indefinitely; 30-day absolute cap enforced; `__Host-` cookie prefix on HTTPS.
- Password reset: token moved to the URL fragment (kept out of server logs), processing deferred so timing doesn't reveal accounts, token checks rate limited, dev console no longer prints email bodies.
- Nonce-based Content-Security-Policy on all pages; all pages render dynamically.
- `/api/health` is liveness-only (deep DB check needs `CRON_SECRET`); public school name cached — prevents uptime monitors and crawlers from draining Neon's free compute hours.
- Rate-limit keys hashed (no usernames/emails stored); more audit redaction keys; scope coverage is a partial order.

### Added (Phase 1 completion work, offline)
- User management (create with one-time temporary password, edit, roles, deactivate/reactivate, admin reset, unlock, sign out everywhere).
- Roles & permissions management (create, rename, per-permission scope editor, delete unused roles).
- Super Admin protections, last-Super-Admin guard and anti-escalation policy (`identity.policy.ts`).
- Self-service password reset (forgot/reset pages, single-use hashed tokens, email `log`/Resend providers with free-tier cap).
- My account page (change password, sign out other devices); "not permitted" screen; confirmation dialogs.
- Scheduled cleanup endpoint, CLI script and GitHub Actions workflow; `npm run env:check` (branch-identity guard).
- shadcn/ui component library (radix-nova) with 44 px mobile controls; e2e auth-pages and admin specs; unit tests for policies, schemas, email, cron auth.

### Fixed
- Forgot-password page was prerendered at build time (school name frozen) — now dynamic.
- Error text colour failed WCAG AA (4.49:1) — destructive colour now red-700 (6.5:1).
- `shadcn` CLI moved to devDependencies (removed 6 advisories from the production dependency tree).

### Security
- Forced password change now enforced in `requireAuth()` and `authorize()` (was layout-only and bypassable).
- Rate-limit client IP taken from the proxy-appended `X-Forwarded-For` entry (`TRUSTED_PROXY_HOPS`).
- Session cookie `Secure` follows the `APP_URL` scheme; production refuses non-HTTPS `APP_URL`.
- Environment validated at server start; DB connection timeout; change-password verification rate limited.

### Added
- Error boundaries; graceful degradation of public/login pages when the DB is unreachable.
- `docs/RBAC_MATRIX.md` (generated, test-enforced) and full 13×79 matrix tests; data-isolation invariant tests.
- Integration tests: DB-loaded permissions for all roles, deactivation, audit rollback, true 50-connection concurrency.
- Playwright e2e (Desktop Chrome, Pixel 7, iPhone 14) incl. axe accessibility and degraded-DB suites.
- `scripts/backup-drill.ts` logical backup/restore verification; `npm run rbac:matrix`, `npm run test:e2e`.

### Changed
- Runtime moved to Node.js 26 LTS (`engines >=26.0.0`, `.nvmrc`, `@types/node` 26); npm 11 install-script allowlist added.
- `.gitignore` hardened; Git repository initialized (no commits).
- Claude settings: env-file deny rules limited to real secret files; `.env.example` corrected to current variables.

### Added
- Free-tier infrastructure strategy (docs/FREE_TIER.md, ADR-016…021).
- Next.js 16 / Prisma 7 project scaffold; Phase 1 schema and initial migration (with pgvector).
- Authentication (Argon2id, DB sessions, lockout, rate limiting), RBAC engine with 13 seeded roles, audit log, encryption, sequences, free-tier usage guard.
- Login, forced password change, ERP shell, health endpoint; seed and `db:check` scripts; unit and integration tests.
- Phase 0 architecture, database design, security model and project documentation.
- Claude Code project configuration: rules, skills, agents.
