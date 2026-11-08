# API Documentation

Status: **conventions only** (Phase 0). Each phase adds its endpoints below; nothing is listed until it is implemented and tested.

## Conventions

- Base path: `/api/v1`. JSON only. Auth via `sid` session cookie (same-origin). Public endpoints are marked **public**.
- Server actions are used for ERP forms; they call the same services as the REST handlers. REST exists for: exports/downloads, imports, integrations, mobile clients, webhooks, chatbot.
- Request validation: Zod; invalid input → `422`.
- Pagination: `?page=1&pageSize=25` (max 100) → `{ data: [...], page, pageSize, total }`.
- Filtering: explicit query params per endpoint (no generic query language).
- Idempotency: `POST` that creates payments or imports accepts `Idempotency-Key` header.

### Error envelope

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have permission to perform this action.", "requestId": "req_…", "details": [] } }
```

| HTTP | code |
|---|---|
| 400 | BAD_REQUEST |
| 401 | UNAUTHENTICATED |
| 403 | FORBIDDEN |
| 404 | NOT_FOUND |
| 409 | CONFLICT (duplicate, state transition not allowed) |
| 422 | VALIDATION_FAILED (`details`: `[{ path, message }]`) |
| 429 | RATE_LIMITED |
| 500 | INTERNAL (no internals in message) |

## Implemented endpoints

| Method & path | Auth | Purpose | Responses |
|---|---|---|---|
| `GET /api/health` | public | **Liveness only** — never touches the DB (so monitors don't keep Neon awake) | `200 {"status":"ok"}` |
| `GET /api/health?deep=1` | `Authorization: Bearer $CRON_SECRET` | Liveness + DB reachability | `200 {"status":"ok","database":"ok"}` · `401` · `503 {"status":"degraded","database":"unreachable"}` |
| `POST /api/cron/cleanup` | `Authorization: Bearer $CRON_SECRET` (≥ 32 chars; endpoint disabled if unset) | Deletes expired sessions, expired rate-limit buckets, reset tokens > 7 days old, usage counters > 400 days | `200 {"status":"ok","deleted":{sessions,rateLimitBuckets,resetTokens,usageCounters}}` · `401` · `503` |

ERP screens use **server actions** (not REST) that call the same services:

| Screen | Actions (service → permission) |
|---|---|
| `/login`, `/forgot-password`, `/reset-password` | `login`, `requestPasswordReset`, `completePasswordReset` (public, rate limited) |
| `/erp/change-password`, `/erp/account` | `changeOwnPassword` (self), `revokeUserSessions(self, keepCurrent)` |
| `/erp/users`, `/erp/users/new`, `/erp/users/[id]` | `listUsers`/`getUser` → `user.read`; `createUser`, `updateUser`, `setUserActive`, `adminResetPassword`, `unlockUser`, `revokeUserSessions` → `user.manage` + policy |
| `/erp/roles`, `/erp/roles/new`, `/erp/roles/[id]` | `listRoles`, `getRole`, `createRole`, `updateRole`, `setRolePermissions`, `deleteRole` → `role.manage` + policy |

## Planned endpoint groups

| Group | Base | Phase |
|---|---|---|
| Auth | `/api/v1/auth/{login,logout,password-reset}` | 1 |
| Users & roles | `/api/v1/users`, `/api/v1/roles` | 1 |
| Files | `/api/v1/files/:id` (authorized download) | 1 |
| CMS public | `/api/v1/public/*` **public** | 2 |
| Enquiries | `POST /api/v1/public/enquiries` **public**, rate-limited | 2 |
| Students & admissions | `/api/v1/students`, `/api/v1/admissions` | 3 |
| Roll numbers | `/api/v1/sections/:id/roll-numbers/{preview,generate,finalize,correct}` | 4 |
| Documents | `/api/v1/documents/{id-cards,certificates}`, `GET /verify/:code` **public** | 5 |
| HR | `/api/v1/employees`, `/api/v1/leave-requests` | 6–7 |
| Attendance | `/api/v1/attendance/{students,employees}` | 7 |
| Payroll | `/api/v1/payroll-runs`, `/api/v1/payroll-runs/:id/{prepare,approve,pay}` | 7 |
| Fees | `/api/v1/fee-structures`, `/api/v1/invoices`, `/api/v1/payments`, `/api/v1/payments/online/order` | 8 |
| Webhooks | `POST /api/webhooks/payments/razorpay` (signature-verified) | 8 |
| Transport | `/api/v1/transport/{vehicles,routes,assignments}` | 9 |
| Exams | `/api/v1/exams`, `/api/v1/exams/:id/marks`, `/api/v1/report-cards` | 10 |
| Library/Inventory | `/api/v1/library/*`, `/api/v1/inventory/*` | 11 |
| Import/Export | `/api/v1/imports`, `/api/v1/exports/:report` | 12 |
| Chatbot | `POST /api/v1/chat` **public**, `/api/v1/chatbot/knowledge` | 13 |
| Notifications | `/api/v1/notifications` | 14 |
