# System Architecture

## 1. Overview

A **modular monolith** on Next.js. One codebase, one deployment, one PostgreSQL database, strict internal module boundaries.

```
                ┌──────────────────────────── Next.js 16 app ─────────────────────────────┐
 Visitors ───▶  │ (public) pages ──▶ cms.public queries (published only)                  │
                │       └─ Chatbot widget ──▶ /api/v1/chat ──▶ src/chatbot (RAG) ──┐      │
 Staff/Parents  │ erp/* pages + server actions ─┐                                    │      │
 /Students ──▶  │ /api/v1/* route handlers ─────┼──▶ modules/*.service ──▶ Prisma ──┼──▶ PostgreSQL (+pgvector)
                │ /api/webhooks/payments ───────┘     │  authorize()  audit()        │      │
                │                                      ├─▶ StorageAdapter ──▶ disk / S3     │
                │                                      ├─▶ PDF renderer                     │
                │                                      └─▶ NotificationDispatcher (in-app; email/SMS later)
                └──────────────────────────────────────────────────────────────────────────┘
```

## 2. Key decisions (ADR log)

| # | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| ADR-001 | Modular monolith in Next.js (no separate backend) | One team, one school; shared Zod types end-to-end; simpler deploy. Module boundaries keep a later split possible. | Separate NestJS API (more infra, duplicated types) |
| ADR-002 | **Single-tenant** (one school per deployment) | Spec targets one real school. Removes `schoolId` from every query and a whole class of data-leak bugs. | Multi-tenant SaaS (can be added later via `tenantId` + RLS) |
| ADR-003 | Custom DB sessions, not JWT | Instant revocation (deactivate user, logout everywhere), no token-in-localStorage risk. | Auth.js (credentials provider discourages DB sessions); Lucia (deprecated); JWT |
| ADR-004 | Argon2id via `@node-rs/argon2` | OWASP-recommended; prebuilt binaries (works on Windows dev without build tools). | bcrypt |
| ADR-005 | Permission strings + record scopes | Roles are bundles of permissions editable by Super Admin; scopes (`ALL`/`ASSIGNED`/`SELF`/`CHILDREN`) handle teacher/parent/student visibility. | Hard-coded role checks |
| ADR-006 | Service layer is the only mutation path | Single place for authz, validation, transactions, audit; reused by UI actions, REST, imports. | Logic in route handlers |
| ADR-007 | Row-locked counter table for sequences | Gap-tolerant, duplicate-proof under concurrency, format configurable, per-session counters. | Postgres SEQUENCE (no per-year reset/format), `MAX()+1` (races) |
| ADR-008 | Roll-number sort in application with `Intl.Collator` | Deterministic, locale-aware, case/accent-insensitive regardless of DB collation; testable as a pure function. | `ORDER BY name` (collation-dependent) |
| ADR-009 | `Decimal(12,2)` + `decimal.js` | Exact money arithmetic. | Float; integer paise (fine, but Decimal reads clearer in reports) |
| ADR-010 | pgvector in the same Postgres + FTS fallback | No extra vector DB; chatbot still works (keyword retrieval) if no embedding provider is configured. | Pinecone/Qdrant |
| ADR-011 | Chatbot isolated from ERP modules (lint-enforced) | Public endpoint must be structurally unable to read student/staff/salary data. | Prompt-only restrictions |
| ADR-012 | `@react-pdf/renderer` for documents | Pure JS (no headless Chrome in serverless), React templates, good typography. | Puppeteer (heavy, cold starts), pdfkit (imperative) |
| ADR-013 | Razorpay as first payment adapter behind `PaymentGateway` interface | UPI/cards/netbanking in India, signed webhooks. Others pluggable. | Hard-wiring one gateway |
| ADR-014 | Application-level encryption for Aadhaar | Protects against DB dump exposure; HMAC allows duplicate detection without decryption. | Plain column; pgcrypto (key would live in SQL) |
| ADR-015 | shadcn/ui on Radix | Accessible primitives, code owned in repo, Tailwind-native. | MUI (heavier, harder to theme with Tailwind) |
| ADR-016 | **Free-only infrastructure; portable deployment** (2026-11-08) | Owner requirement: zero recurring cost during development. Neon Free for Postgres; `output: "standalone"` Node server so the app runs on any host; every external service optional behind an interface with a no-cost default. Details and limits: docs/FREE_TIER.md. | Vendor-specific runtimes (Vercel-only features, Edge-only code) |
| ADR-017 | Prisma 7 with `@prisma/adapter-pg` (node-postgres) over Neon's **pooled** URL at runtime; **direct** URL for migrations via `prisma.config.ts` | Standard TCP driver works with Neon and any other Postgres, in long-running servers and serverless alike; Neon's pooler handles connection limits. | `@prisma/adapter-neon` (WebSocket, Neon-specific — can be swapped in later for edge/serverless if needed) |
| ADR-018 | **Split file storage**: public media → Cloudinary Free (or local); private documents → private store, **encrypted by the app (AES-256-GCM) before writing** | Public CDN for website images is ideal; confidential files must never be on a public CDN. App-side encryption means any free/cheap S3-compatible provider sees only ciphertext, reducing reliance on provider privacy terms. Downloads only via an authorized route (no public URLs). | Cloudinary private/authenticated assets for documents (still a media CDN, keys shared with public media); unencrypted buckets |
| ADR-019 | Rate limiting and usage metering in **Postgres** | No paid Redis; works across instances. Daily usage caps below free-tier limits (`lib/usage`) stop calls before a provider limit or charge is reached. | Upstash/Redis (extra service) |
| ADR-020 | Chatbot defaults to **no LLM** (FAQ + Postgres full-text search); LLM optional, capped, provider-configurable | Free LLM tiers found so far restrict use by minors or use prompts for training (Gemini). Retrieval-only answers are deterministic, free and cannot hallucinate. Optional local embeddings model for semantic search without an API. | Paid LLM by default |
| ADR-022 | Identity administration via **server actions + pure policy module** (`identity.policy.ts`) | All protection/anti-escalation rules are side-effect-free functions (fully unit-tested offline) called by services inside transactions; UI uses the same functions only to disable options. | Rules embedded in route handlers or UI |
| ADR-023 | shadcn/ui `radix-nova` with project-level overrides (44 px touch sizes, AA-contrast destructive colour, system fonts) | Keeps accessibility and offline builds; components are owned code so overrides are local and reviewable. | Upstream defaults (32 px controls, 4.49:1 error text, Google font fetch at build) |
| ADR-024 | Nonce-based CSP via `src/proxy.ts`; **all pages dynamic** (root layout `dynamic = "force-dynamic"`) | Strict script policy without `unsafe-inline`; static pages can't carry per-request nonces (verified: a prerendered page's scripts were blocked). Also keeps sensitive pages out of shared caches. Cost: no static prerendering — public pages get explicit data caching instead (Phase 2). | Hash-based CSP (brittle with framework scripts); no CSP |
| ADR-025 | Super Admin membership changes serialized by a transaction-scoped advisory lock | Correct under READ COMMITTED and transaction-mode pooling; one cheap lock for rare admin operations. | Row locks over joins (unsafe), SERIALIZABLE everywhere (retry complexity) |
| ADR-026 | Layer rules enforced by ESLint + `npm run check:deps` (TypeScript-API cycle/boundary checker) | Boundaries in §3 were conventions only; now CI-checkable without external tools. | madge/dependency-cruiser (external download) |
| ADR-021 | Email via provider interface with `log` default (dev preview), Resend Free optional | Development needs no account; production can enable Resend within its 100/day cap (app caps at 90). | Hard dependency on one email provider |

## 3. Module map

| Module | Owns models | Depends on |
|---|---|---|
| `identity` | User, Session, Role, Permission, UserRole, RolePermission, PasswordResetToken | — |
| `settings` | SchoolSetting, AcademicSession, SequenceCounter, DocumentTemplate | identity |
| `cms` | CMSPage, CMSSection, MenuItem, Notice, Event, News, GalleryAlbum, GalleryImage, Download, Banner, AdmissionEnquiry | settings, storage |
| `academics` | SchoolClass, Section, Subject, ClassSubject, TeacherAllocation, TimetableSlot, Period | settings |
| `students` | Student, Guardian, StudentGuardian, StudentDocument, Admission, StudentEnrollment, StudentRollNumber, RollNumberBatch, DisciplineRecord, MedicalRecord, StudentStatusChange | academics, settings |
| `hr` | Employee, Teacher (profile), Department, Designation, EmployeeDocument, ServiceHistory, LeaveType, LeaveBalance, LeaveRequest | settings |
| `attendance` | StudentAttendance, EmployeeAttendance | students, hr |
| `payroll` | SalaryComponent, SalaryStructure, EmployeeSalary, PayrollRun, Payroll (slip), SalaryAdvance, SalaryPayment | hr, attendance |
| `fees` | FeeCategory, FeeStructure, FeeStructureItem, FeeConcession, StudentConcession, FeeInvoice, FeeInvoiceItem, FeePayment, FeeReceipt, PaymentGatewayEvent | students, academics |
| `transport` | TransportVehicle, VehicleDocument, Driver, TransportRoute, TransportStop, StudentTransport, VehicleMaintenance, FuelRecord | students, fees |
| `exams` | Examination, ExamSubject, ExaminationMarks, GradeScale, GradeBand, ReportCard | academics, students |
| `library` | LibraryBook, BookCopy, BookIssue, LibraryFine | students, hr |
| `inventory` | InventoryItem (asset), AssetCategory, Vendor, AssetMaintenance, AssetDisposal, Location | — |
| `documents` | GeneratedDocument, IdCardTemplate | all read-only |
| `importexport` | ImportJob, ImportRow | target module services |
| `notifications` | Notification, NotificationPreference | — |
| `chatbot` | ChatbotKnowledge, KnowledgeChunk, ChatbotFAQ, ChatbotConfig, ChatConversation, ChatMessage | lib/ai only |
| `audit` | AuditLog | — |

Dependencies point one way. Cross-module calls go through the other module's service, never its tables.

## 4. Request lifecycle (mutating)

1. Route handler / server action → `getAuthContext()` (validates session cookie, loads user + permission set, cached per request).
2. `schema.parse(input)` (Zod) → 422 on failure.
3. `service.fn(ctx, input)`:
   - `authorize(ctx, "student.update")` → 403
   - policy check on the target record (scope) → 403/404 (404 when existence itself is sensitive)
   - `prisma.$transaction(async tx => { …mutate…; await audit(tx, …) })`
   - enqueue notifications (after commit)
4. Map result / `AppError` → JSON or redirect.

## 5. Cross-cutting

- **Logging**: structured JSON (pino), request id, no PII (redaction list in `lib/logger`).
- **Rate limiting**: `lib/rate-limit`; Postgres-backed fixed windows (default) or in-memory for single-process dev (ADR-019).
- **Free-tier usage guard**: `lib/usage.consume(metric)` before every metered external call; warns at 80 %, stops at the cap (ADR-019). Applied to login, password reset, enquiry form, chatbot, uploads.
- **Background work**: Phase 1 runs synchronously with idempotent design; bulk PDF/imports use a DB-backed job table processed by a route-triggered worker (cron on hosting). Can move to a queue (e.g. pg-boss) without API changes.
- **Caching**: public pages use Next.js caching with tag revalidation on CMS publish. ERP pages are dynamic, never cached across users.
- **i18n**: UI strings centralised to allow Hindi later (see ROADMAP).

## 6. Hosting topology

**Development (free):** local `next dev` · Neon Free project, `development` branch · private files on local encrypted disk · public media local or Cloudinary Free · email `log` mode · chatbot retrieval-only.

**Production (portable, ADR-016):** Next.js standalone Node server on a host whose terms permit institutional use · Neon `production` branch (or any Postgres 16+ with pgvector) · private S3-compatible bucket with app-side encryption, downloads through an authorized route issuing short-lived signed URLs · Cloudinary for public media · scheduled jobs via host cron hitting `/api/cron/*`. Host choice and its terms are evaluated in docs/FREE_TIER.md and DEPLOYMENT.md (Vercel Hobby is excluded for production: non-commercial personal use only).
