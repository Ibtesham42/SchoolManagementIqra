# RBAC Matrix (default grants)

> Generated from `src/lib/rbac/catalog.ts` by `npm run rbac:matrix`. Do not edit by hand —
> `tests/unit/rbac-matrix.test.ts` fails if this file is out of date.
> Super Admin may change non-system roles at runtime; this is the seeded default.

Legend: ✓ = all records · A = assigned records only · S = own record only · C = linked children only · blank = denied

Roles: 13 · Permissions: 89

| Permission | SUPER_ADMIN | SCHOOL_ADMIN | PRINCIPAL | VICE_PRINCIPAL | ACCOUNTANT | HR_MANAGER | ADMISSION_OFFICER | TEACHER | CLASS_TEACHER | TRANSPORT_MANAGER | LIBRARIAN | PARENT | STUDENT |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `user.read` — View user accounts | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `user.manage` — Create, edit, deactivate users and assign roles | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `role.manage` — Edit roles and their permissions | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `settings.read` — View school settings | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `settings.manage` — Change school settings | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `session.manage` — Manage academic sessions | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `template.manage` — Manage document and ID card templates | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `cms.read` — View website content in the CMS | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| `cms.edit` — Edit website content drafts | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `cms.publish` — Publish website content | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| `enquiry.read` — View admission enquiries | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  |  |  |  |  |  |
| `enquiry.manage` — Update admission enquiries | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |
| `admission.read` — View admissions | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  |  |  |  |  |  |
| `admission.create` — Create admissions | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |
| `admission.approve` — Approve admissions and override duplicate warnings | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| `student.read` — View student records | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | A | A | A | ✓ | C | S |
| `student.create` — Create students | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |
| `student.update` — Edit student records | ✓ | ✓ |  |  |  |  | ✓ |  | A |  |  |  |  |
| `student.delete` — Soft-delete student records | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `student.sensitive.read` — View Aadhaar and medical information | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| `student.document.read` — View student documents | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |  |  |  |  |  |  |
| `student.document.manage` — Upload, replace, verify and remove student and admission documents | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |
| `student.promote` — Promote students | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `student.transfer` — Transfer or withdraw students | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `discipline.manage` — Record discipline incidents | ✓ |  |  |  |  |  |  |  | A |  |  |  |  |
| `rollnumber.generate` — Preview and generate draft roll numbers | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |
| `rollnumber.finalize` — Finalize roll numbers | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| `rollnumber.correct` — Correct finalized roll numbers | ✓ |  | ✓ |  |  |  |  |  |  |  |  |  |  |
| `idcard.generate` — Generate ID cards | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |
| `document.generate` — Generate school documents | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |
| `document.revoke` — Revoke issued documents (they then fail public verification) | ✓ |  | ✓ |  |  |  |  |  |  |  |  |  |  |
| `certificate.issue` — Issue certificates | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| `employee.read` — View employee records | ✓ | ✓ | ✓ | ✓ | S | ✓ | S | S | S | S | ✓ |  |  |
| `employee.manage` — Create and edit employees | ✓ | ✓ |  |  |  | ✓ |  |  |  |  |  |  |  |
| `employee.sensitive.read` — View employee PAN/bank details | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |  |
| `employee.personal.read` — View employee personal details and documents | ✓ | ✓ | ✓ | S | S | ✓ | S | S | S | S | S |  |  |
| `employee.document.manage` — Upload, verify and remove employee documents and photos | ✓ | ✓ |  |  |  | ✓ |  |  |  |  |  |  |  |
| `leave.request` — Request leave | ✓ |  |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `leave.approve` — Approve or reject leave | ✓ |  | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |  |
| `attendance.student.mark` — Mark student attendance | ✓ |  |  |  |  |  |  | A | A |  |  |  |  |
| `attendance.student.read` — View student attendance | ✓ | ✓ | ✓ | ✓ |  |  |  | A | A |  |  | C | S |
| `attendance.employee.mark` — Mark employee attendance | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |  |
| `attendance.employee.read` — View employee attendance | ✓ | ✓ | ✓ | ✓ | S | ✓ | S | S | S | S | S |  |  |
| `payroll.read` — View payroll and salaries | ✓ |  | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |
| `payroll.prepare` — Prepare payroll runs | ✓ |  |  |  | ✓ | ✓ |  |  |  |  |  |  |  |
| `payroll.approve` — Approve payroll runs | ✓ |  | ✓ |  |  |  |  |  |  |  |  |  |  |
| `payroll.pay` — Record salary payments | ✓ |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `salary.structure.manage` — Manage salary structures | ✓ |  |  |  |  | ✓ |  |  |  |  |  |  |  |
| `salary.self.read` — View own salary slips | ✓ | S | S | S | S | S | S | S | S | S | S |  |  |
| `fee.structure.manage` — Manage fee structures and generate invoices | ✓ |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `fee.read` — View fees and invoices | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  | C |  |
| `fee.collect` — Collect fee payments | ✓ |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `fee.concession.manage` — Manage concessions and scholarships | ✓ |  |  |  | ✓ |  |  |  |  |  |  |  |  |
| `fee.concession.approve` — Approve concessions and scholarships | ✓ |  | ✓ |  |  |  |  |  |  |  |  |  |  |
| `fee.refund` — Cancel receipts and refund payments | ✓ |  | ✓ |  | ✓ |  |  |  |  |  |  |  |  |
| `fee.report` — View fee reports | ✓ |  | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `fee.pay.online` — Pay fees online | ✓ |  |  |  |  |  |  |  |  |  |  | C |  |
| `transport.read` — View transport | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |
| `transport.manage` — Manage vehicles, routes and stops | ✓ |  |  |  |  |  |  |  |  | ✓ |  |  |  |
| `transport.assign` — Assign students to routes | ✓ |  |  |  |  |  |  |  |  | ✓ |  |  |  |
| `academic.read` — View classes and sections | ✓ | ✓ | ✓ | ✓ |  |  | ✓ | A | A |  |  |  |  |
| `academic.manage` — Manage classes, sections, subjects and allocations | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `timetable.read` — View timetables | ✓ | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  |  | C | S |
| `timetable.manage` — Manage timetables | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `exam.manage` — Manage examinations | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| `marks.enter` — Enter marks | ✓ |  |  |  |  |  |  | A | A |  |  |  |  |
| `marks.approve` — Approve marks | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| `result.read` — View results | ✓ |  | ✓ | ✓ |  |  |  | A | A |  |  | C | S |
| `result.publish` — Publish results | ✓ |  | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| `reportcard.generate` — Generate report cards | ✓ | ✓ | ✓ |  |  |  |  |  | A |  |  |  |  |
| `homework.manage` — Post and manage homework | ✓ | ✓ |  |  |  |  |  | A | A |  |  |  |  |
| `homework.read` — View homework | ✓ |  |  |  |  |  |  |  |  |  |  | C | S |
| `library.read` — View library | ✓ | ✓ | ✓ | ✓ |  |  |  | ✓ | ✓ |  | ✓ |  | S |
| `library.manage` — Manage library catalogue | ✓ |  |  |  |  |  |  |  |  |  | ✓ |  |  |
| `library.issue` — Issue and return books | ✓ |  |  |  |  |  |  |  |  |  | ✓ |  |  |
| `inventory.read` — View inventory | ✓ | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |
| `inventory.manage` — Manage inventory | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `import.run` — Run data imports | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `export.run` — Run data exports | ✓ | ✓ |  |  | ✓ | ✓ |  |  |  |  |  |  |  |
| `chatbot.manage` — Manage chatbot knowledge and settings | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `chatbot.analytics` — View chatbot analytics | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `notice.read` — View notices | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | C | S |
| `notice.manage` — Write, publish and withdraw notices | ✓ | ✓ | ✓ |  |  |  |  |  | A |  |  |  |  |
| `portal.account.manage` — Manage parent and student portal accounts | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |  |
| `audit.read` — View audit logs | ✓ |  | ✓ |  |  |  |  |  |  |  |  |  |  |
| `backup.manage` — Manage backups | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `integration.manage` — Configure integrations | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |
| `notification.send` — Send notifications | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |  |  |  |
| `usage.read` — View free-tier usage and limits | ✓ |  |  |  |  |  |  |  |  |  |  |  |  |

## Grant counts

| Role | Permissions granted |
|---|--:|
| Super Admin (`SUPER_ADMIN`) | 89 |
| School Admin (`SCHOOL_ADMIN`) | 47 |
| Principal (`PRINCIPAL`) | 38 |
| Vice Principal (`VICE_PRINCIPAL`) | 25 |
| Accountant (`ACCOUNTANT`) | 18 |
| HR Manager (`HR_MANAGER`) | 15 |
| Admission Officer (`ADMISSION_OFFICER`) | 19 |
| Teacher (`TEACHER`) | 15 |
| Class Teacher (`CLASS_TEACHER`) | 19 |
| Transport Manager (`TRANSPORT_MANAGER`) | 10 |
| Librarian (`LIBRARIAN`) | 10 |
| Parent (`PARENT`) | 8 |
| Student (`STUDENT`) | 7 |
