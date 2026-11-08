# Database Schema (design — Phase 0)

PostgreSQL 16+ (Neon Free), Prisma 7, extension `vector` (pgvector). `prisma/schema.prisma` is the source of truth; this document must be kept in sync.

**Implemented (Phase 1, migration `20261108000000_init`, 15 tables):** User, Session, PasswordResetToken, Role, Permission, RolePermission, UserRole, SchoolSetting, AcademicSession, SequenceCounter, StoredFile, AuditLog, Notification, RateLimitBucket, UsageCounter. Everything else below is still the plan for later phases.

Phase 1 deviations from the original plan (to avoid raw-SQL partial indexes that Prisma's diffing would try to drop):
- `User.email` is stored lowercased with a plain unique constraint (NULLs allowed) instead of a `lower(email)` partial index.
- `AcademicSession.isCurrent` was replaced by `SchoolSetting.currentAcademicSessionId` (unique FK) — guarantees at most one current session.
- New: `StoredFile.provider`, `encrypted`, `keyVersion` (ADR-018); `RateLimitBucket` and `UsageCounter` (ADR-019); `AuditLog.id` is a BigInt identity.

## Conventions

- PK: `id String @id @default(cuid(2))` (unguessable; no enumeration). Human-facing numbers (admission no., receipt no.) are separate unique columns.
- Every table: `createdAt timestamptz default now()`, `updatedAt @updatedAt`. Mutable records also have `createdById`/`updatedById` → User.
- Soft delete: `deletedAt timestamptz?` on models marked **(SD)**. Unique constraints that must ignore deleted rows use partial unique indexes (raw SQL in migration).
- Money: `Decimal @db.Decimal(12,2)`. Dates without time: `@db.Date`.
- Enums are Postgres enums unless the value set is school-configurable (then a lookup table).
- Session-scoped tables carry `academicSessionId` (FK, indexed).

Legend: **PK** primary key · **U** unique · **IX** index · **FK** foreign key

## 1. Identity & access

| Model | Key fields | Constraints / indexes |
|---|---|---|
| User (SD) | username, email?, passwordHash, isActive, mustChangePassword, lastLoginAt, failedLoginCount, lockedUntil, employeeId?, studentId?, guardianId? | U(username), U(lower(email)) partial where not null, U(employeeId), U(studentId), U(guardianId) |
| Session | tokenHash, userId, expiresAt, lastSeenAt, ip, userAgent | U(tokenHash), IX(userId), IX(expiresAt) |
| PasswordResetToken | tokenHash, userId, expiresAt, usedAt | U(tokenHash) |
| Role | key, name, description, isSystem | U(key) |
| Permission | key, module, description | U(key) |
| RolePermission | roleId, permissionId, scope (ALL/ASSIGNED/SELF/CHILDREN) | PK(roleId, permissionId) |
| UserRole | userId, roleId | PK(userId, roleId) |

## 2. Settings & core

| Model | Key fields | Constraints |
|---|---|---|
| SchoolSetting | singleton (`id = 'default'`): name, shortCode, affiliationNo, board, address JSON, phones, email, logoFileId, timezone, timings JSON, branding JSON, idFormats JSON, rollNumberRules JSON, chatbot/notification/backup/integration JSON (no secrets) | — |
| AcademicSession | name ("2026-27"), startDate, endDate, isCurrent, status (PLANNED/ACTIVE/CLOSED) | U(name); partial U(isCurrent) where true |
| SequenceCounter | key (e.g. `student_id:2026`), value Int | PK(key) — updated via `UPDATE … SET value = value + 1 RETURNING value` |
| StoredFile | storageKey, originalName, mimeType, sizeBytes, sha256, visibility (PUBLIC/PRIVATE), uploadedById | U(storageKey), IX(sha256) |
| DocumentTemplate | kind (ID_CARD/CERTIFICATE/RECEIPT/SLIP/REPORT_CARD), name, config JSON, isDefault | IX(kind) |
| GeneratedDocument | kind, entityType, entityId, fileId, serialNo?, generatedById, verificationCode? | IX(entityType, entityId), U(verificationCode) |

## 3. Academics

| Model | Key fields | Constraints |
|---|---|---|
| SchoolClass | name ("Class 6"), numericLevel, displayOrder, isActive | U(name) |
| Section | classId, name ("A"), capacity, academicSessionId, classTeacherId? (Employee) | U(academicSessionId, classId, name) |
| Subject | code, name, type (THEORY/PRACTICAL/BOTH), isElective | U(code) |
| ClassSubject | academicSessionId, classId, subjectId, maxTheory, maxPractical, maxInternal | U(session, class, subject) |
| TeacherAllocation | academicSessionId, employeeId, sectionId, subjectId | U(session, section, subject, employee) |
| Period | name, startTime, endTime, order, isBreak | — |
| TimetableSlot | academicSessionId, sectionId, dayOfWeek, periodId, subjectId, employeeId, room? | U(session, section, day, period); U(session, employee, day, period) — no teacher double-booking |

## 4. Students & admissions

| Model | Key fields | Constraints |
|---|---|---|
| Student (SD) | studentCode (permanent ID, e.g. `JNV-2026-0001`), admissionNo, firstName, middleName?, lastName?, fullNameNormalized, dob, gender, bloodGroup?, aadhaarEnc?, aadhaarHmac?, aadhaarLast4?, category?, religion?, nationality, address JSON, state, district, pinCode, photoFileId?, status (ACTIVE/TRANSFERRED/WITHDRAWN/ALUMNI/PASSED_OUT), admissionDate | U(studentCode), U(admissionNo), partial U(aadhaarHmac) where not null and deletedAt null, IX(fullNameNormalized), IX(status) |
| Guardian (SD) | name, relation-agnostic person: phone, altPhone?, email?, occupation?, address JSON? | IX(phone) |
| StudentGuardian | studentId, guardianId, relation (FATHER/MOTHER/GUARDIAN/OTHER), isPrimary, isEmergencyContact | PK(studentId, guardianId) |
| Admission | studentId, academicSessionId, admittedClassId, previousSchool?, previousClass?, previousRecords JSON?, status (DRAFT/SUBMITTED/APPROVED/REJECTED), approvedById?, approvedAt?, enquiryId? | U(studentId, academicSessionId) |
| StudentDocument (SD) | studentId, type (BIRTH_CERT/PREV_SCHOOL_CERT/TC/PHOTO/OTHER), fileId, verifiedById?, verifiedAt? | IX(studentId) |
| StudentEnrollment | studentId, academicSessionId, classId, sectionId, status (ACTIVE/PROMOTED/DETAINED/LEFT), enrolledAt, leftAt? | U(studentId, academicSessionId), IX(sectionId) |
| RollNumberBatch | academicSessionId, sectionId, status (DRAFT/FINALIZED), generatedById, finalizedById?, finalizedAt?, version | U(academicSessionId, sectionId) |
| StudentRollNumber | enrollmentId, batchId, rollNumber, isFinal | U(enrollmentId), U(batchId, rollNumber) |
| StudentStatusChange | studentId, fromStatus, toStatus, reason, effectiveDate, tcIssued, actedById | IX(studentId) |
| DisciplineRecord (SD) | studentId, academicSessionId, date, category, description, actionTaken, recordedById | IX(studentId) |
| MedicalRecord | studentId (1:1), allergies?, conditions?, medications?, doctorContact?, notes? — **restricted** | U(studentId) |
| StudentHistory | studentId, field, oldValue (redacted if sensitive), newValue, changedById — denormalised view of AuditLog for profile timeline (optional; may be a query over AuditLog) | IX(studentId) |

## 5. HR

| Model | Key fields | Constraints |
|---|---|---|
| Department | name, code | U(code) |
| Designation | name, code, category (TEACHING/NON_TEACHING) | U(code) |
| Employee (SD) | employeeCode, type (TEACHING/NON_TEACHING), firstName, lastName?, dob, gender, phone, email?, address JSON, photoFileId?, departmentId, designationId, joiningDate, appointmentType (PERMANENT/CONTRACT/PROBATION/GUEST/PART_TIME), employmentStatus (ACTIVE/ON_LEAVE/RESIGNED/TERMINATED/RETIRED), bankAccountEnc?, ifsc?, panEnc?, panLast4? | U(employeeCode), IX(type, employmentStatus) |
| TeacherProfile | employeeId (1:1), qualifications JSON, professionalQualifications JSON, specializations, experienceYears | U(employeeId) |
| EmployeeDocument (SD) | employeeId, type, fileId | IX(employeeId) |
| ServiceHistory | employeeId, eventType (JOINED/PROMOTED/TRANSFERRED/DESIGNATION_CHANGE/RESIGNED…), effectiveDate, details JSON | IX(employeeId) |
| LeaveType | code, name, annualQuota, isPaid, carryForward | U(code) |
| LeaveBalance | employeeId, leaveTypeId, academicSessionId, allotted, used | U(employee, leaveType, session) |
| LeaveRequest | employeeId, leaveTypeId, fromDate, toDate, halfDay, days Decimal(4,1), reason, status (PENDING/APPROVED/REJECTED/CANCELLED), decidedById?, decidedAt? | IX(employeeId, status) |

## 6. Attendance

| Model | Key fields | Constraints |
|---|---|---|
| StudentAttendance | academicSessionId, enrollmentId, date, status (PRESENT/ABSENT/LATE/HALF_DAY/EXCUSED), markedById, remarks? | U(enrollmentId, date), IX(academicSessionId, date) |
| EmployeeAttendance | employeeId, date, status (PRESENT/ABSENT/LATE/HALF_DAY/ON_LEAVE/HOLIDAY), checkIn?, checkOut?, source (MANUAL/BIOMETRIC/IMPORT), leaveRequestId? | U(employeeId, date) |
| Holiday | date, name, appliesTo (ALL/STUDENTS/STAFF) | U(date, appliesTo) |

## 7. Payroll

| Model | Key fields | Constraints |
|---|---|---|
| SalaryComponent | code, name, kind (EARNING/DEDUCTION), calc (FIXED/PERCENT_OF_BASIC/FORMULA), isStatutory | U(code) |
| SalaryStructure | name, appointmentType?, items JSON or child table SalaryStructureItem(componentId, value) | U(name) |
| EmployeeSalary | employeeId, structureId, basic, effectiveFrom, effectiveTo?, approvedById, approvedAt | IX(employeeId, effectiveFrom); exclusion: no overlapping ranges (raw SQL) |
| PayrollRun | month (YYYY-MM), status (DRAFT/PREPARED/APPROVED/PAID/LOCKED), preparedById, approvedById?, totals | U(month) |
| Payroll (salary slip) | payrollRunId, employeeId, slipNo, workingDays, paidDays, lopDays, earnings JSON, deductions JSON, gross, totalDeductions, net, advanceRecovery, bonus, arrears | U(payrollRunId, employeeId), U(slipNo) |
| SalaryAdvance | employeeId, amount, approvedById, recoveryPlan JSON, outstanding | IX(employeeId) |
| SalaryPayment | payrollId, amount, method, bankReference?, paidAt, paidById | U(bankReference) partial where not null |

## 8. Fees

| Model | Key fields | Constraints |
|---|---|---|
| FeeCategory | code, name (Admission/Tuition/Annual/Transport/Hostel/Lab/Other), isRecurring | U(code) |
| FeeStructure | academicSessionId, classId, name, isActive | U(session, class, name) |
| FeeStructureItem | feeStructureId, feeCategoryId, amount, frequency (ONE_TIME/MONTHLY/QUARTERLY/ANNUAL), installmentPlan JSON | U(structure, category) |
| FeeConcession | name, type (PERCENT/FIXED), value, appliesToCategoryIds, kind (CONCESSION/SCHOLARSHIP/DISCOUNT) | U(name) |
| StudentConcession | studentId, concessionId, academicSessionId, approvedById, reason | U(student, concession, session) |
| LateFeeRule | academicSessionId, graceDays, type (FLAT/PER_DAY/PERCENT), value, cap? | — |
| FeeInvoice (SD) | invoiceNo, studentId, academicSessionId, period (e.g. 2026-07), dueDate, subtotal, concessionTotal, lateFee, total, paidAmount, status (DRAFT/ISSUED/PARTIAL/PAID/CANCELLED/WAIVED) | U(invoiceNo), U(studentId, academicSessionId, period), IX(status, dueDate) |
| FeeInvoiceItem | invoiceId, feeCategoryId, description, amount, concessionAmount | IX(invoiceId) |
| FeePayment | paymentNo, studentId, amount, method (CASH/UPI/BANK_TRANSFER/CHEQUE/ONLINE/OTHER), status (PENDING/SUCCESS/FAILED/REFUNDED), transactionRef?, gateway?, gatewayOrderId?, gatewayPaymentId?, idempotencyKey, collectedById?, paidAt | U(paymentNo), U(idempotencyKey), U(gateway, gatewayPaymentId) partial, U(method, transactionRef) partial where not null |
| FeePaymentAllocation | paymentId, invoiceId, amount | PK(paymentId, invoiceId) |
| FeeReceipt | receiptNo, paymentId (1:1), fileId?, issuedAt, cancelledAt?, cancelReason? | U(receiptNo), U(paymentId) |
| PaymentGatewayEvent | gateway, eventId, type, payload JSON, signatureValid, processedAt? | U(gateway, eventId) — webhook idempotency |

## 9. Transport

| Model | Key fields | Constraints |
|---|---|---|
| TransportVehicle (SD) | vehicleNo, model, capacity, insuranceNo/expiry, fitnessExpiry, permitNo/expiry, pucExpiry, status | U(vehicleNo) |
| VehicleDocument | vehicleId, type, fileId, expiresOn? | IX(expiresOn) |
| Driver (SD) | role (DRIVER/CONDUCTOR/ATTENDANT), employeeId?, name, phone, licenseNo?, licenseExpiry? | U(licenseNo) partial |
| TransportRoute | code, name, vehicleId?, driverId?, conductorId?, academicSessionId | U(session, code) |
| TransportStop | routeId, name, sequence, pickupTime, dropTime, lat?, lng?, monthlyFee | U(routeId, sequence) |
| StudentTransport | studentId, academicSessionId, routeId, stopId, startDate, endDate? | IX(routeId); partial U(studentId, session) where endDate null |
| VehicleMaintenance | vehicleId, date, type, description, cost, odometer, vendorId? | IX(vehicleId) |
| FuelRecord | vehicleId, date, litres Decimal(8,2), cost, odometer | IX(vehicleId, date) |

## 10. Examinations

| Model | Key fields | Constraints |
|---|---|---|
| GradeScale | name, isDefault; GradeBand(scaleId, minPercent, maxPercent, grade, gradePoint, remark) | U(scaleId, grade) |
| Examination | academicSessionId, name, term, type (UNIT_TEST/HALF_YEARLY/ANNUAL/PRACTICAL/INTERNAL), startDate, endDate, weightage, status (DRAFT/SCHEDULED/MARKS_ENTRY/LOCKED/PUBLISHED), gradeScaleId | U(session, name) |
| ExamSubject | examinationId, classId, subjectId, date?, maxTheory, maxPractical, maxInternal, passMarks | U(exam, class, subject) |
| ExaminationMarks | examSubjectId, enrollmentId, theory?, practical?, internal?, isAbsent, enteredById, approvedById? | U(examSubjectId, enrollmentId) |
| ReportCard | examinationId (or term aggregate), enrollmentId, totals JSON, percentage, grade, rank?, attendancePct, remarks, fileId?, publishedAt? | U(examinationId, enrollmentId) |

## 11. Library & inventory

| Model | Key fields | Constraints |
|---|---|---|
| LibraryBook (SD) | isbn?, title, authors, publisher, category, edition, totalCopies, availableCopies | IX(isbn), IX(title) |
| BookCopy | bookId, accessionNo, status (AVAILABLE/ISSUED/LOST/DAMAGED/WITHDRAWN) | U(accessionNo) |
| BookIssue | copyId, borrowerType (STUDENT/EMPLOYEE), studentId?, employeeId?, issuedAt, dueDate, returnedAt?, fineAmount, finePaid | IX(copyId); partial U(copyId) where returnedAt null |
| Location | name, building?, room? | U(name) |
| Vendor | name, contact, gstin? | U(name) |
| AssetCategory | name (Computers/Printers/Projectors/Furniture/Lab/Sports/Electrical/Other) | U(name) |
| InventoryItem (SD) | assetTag, categoryId, name, serialNo?, purchaseDate, purchaseAmount, vendorId?, warrantyUntil?, locationId?, assignedToEmployeeId?, status (IN_USE/IN_STORE/UNDER_REPAIR/DISPOSED), quantity (for consumables) | U(assetTag) |
| AssetMaintenance | itemId, date, description, cost, vendorId? | IX(itemId) |
| AssetDisposal | itemId (1:1), date, method, amountRecovered, approvedById | U(itemId) |

## 12. CMS (public website)

| Model | Key fields | Constraints |
|---|---|---|
| CMSPage | slug, title, seoDescription, status (DRAFT/PUBLISHED), publishedAt | U(slug) |
| CMSSection | pageId, type (HERO/RICH_TEXT/PRINCIPAL_MESSAGE/FACILITIES/STATS/GALLERY_STRIP/NOTICES/EVENTS/CONTACT/MAP/CTA…), order, isVisible, content JSON (validated by Zod per type), status | IX(pageId, order) |
| MenuItem | label, href or pageId, parentId?, order, isVisible | IX(parentId, order) |
| Banner | title, subtitle, imageFileId, link?, order, isActive | — |
| Notice (SD) | title, body (sanitized HTML), category, isImportant, attachmentFileId?, publishAt, expireAt?, status | IX(status, publishAt) |
| News (SD) | title, slug, excerpt, body, coverFileId, publishAt, status | U(slug) |
| Event (SD) | title, slug, description, startAt, endAt, venue, coverFileId?, status | U(slug), IX(startAt) |
| GalleryAlbum / GalleryImage | album: title, slug, order, status · image: albumId, fileId, caption, order | U(album.slug) |
| Download | title, category (ADMISSION_FORM/SYLLABUS/CIRCULAR/OTHER), fileId, status | — |
| AdmissionEnquiry | studentName, desiredClass, parentName, phone, email?, message, status (NEW/CONTACTED/CONVERTED/CLOSED), ipHash | IX(status, createdAt) |

## 13. Chatbot

| Model | Key fields | Constraints |
|---|---|---|
| ChatbotConfig | singleton: systemInstructions, provider, model, temperature, maxTokens, fallbackMessage, isEnabled (API keys are **env only**) | — |
| ChatbotKnowledge | title, sourceType (MANUAL/PDF/DOCX/CMS_SYNC), category, body (extracted text), fileId?, isActive, status (DRAFT/PUBLISHED), version | IX(isActive, status) |
| KnowledgeChunk | knowledgeId, chunkIndex, content, tokenCount, embedding vector(N)?, tsv tsvector (generated) | U(knowledgeId, chunkIndex); HNSW index on embedding; GIN on tsv |
| ChatbotFAQ | question, answer, category, isActive, order | — |
| ChatConversation | visitorId (random cookie, not PII), startedAt, messageCount, ipHash | IX(startedAt) |
| ChatMessage | conversationId, role, content, retrievedChunkIds, answered (bool: grounded vs fallback), latencyMs, feedback? | IX(conversationId) |

## 14. Notifications, imports, audit

| Model | Key fields | Constraints |
|---|---|---|
| Notification | userId, type, title, body, link?, readAt?, channel (IN_APP/EMAIL/SMS), deliveryStatus | IX(userId, readAt) |
| NotificationPreference | userId, type, inApp, email, sms | PK(userId, type) |
| ImportJob | module, fileId, mapping JSON, status (UPLOADED/MAPPED/VALIDATED/IMPORTING/COMPLETED/FAILED/CANCELLED), totals, reportFileId?, createdById | IX(createdById) |
| ImportRow | jobId, rowNumber, data JSON, errors JSON, status (VALID/INVALID/DUPLICATE/IMPORTED/SKIPPED), entityId? | U(jobId, rowNumber) |
| AuditLog | actorId?, actorRole, action (e.g. `student.update`), entityType, entityId, before JSON?, after JSON?, ip, userAgent, requestId, at | IX(entityType, entityId), IX(actorId, at), IX(action, at). Append-only (no UPDATE/DELETE grants for the app DB role in prod). |

## 15. Name-to-spec mapping

Spec model → planned model: `StudentClass` → SchoolClass (+StudentEnrollment) · `Attendance` → StudentAttendance + EmployeeAttendance · `Timetable` → TimetableSlot · `Inventory` → InventoryItem · `Gallery` → GalleryAlbum/GalleryImage · `Teacher` → Employee + TeacherProfile (one person table for all staff avoids duplicated HR/payroll logic).
