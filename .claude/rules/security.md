# Security rules

- Every non-public service function takes `ctx: AuthContext` and calls `authorize(ctx, "<permission>")` before touching data, then a record-scope policy for the specific IDs. UI hiding is never sufficient.
- Responses go through serializers that drop sensitive fields (Aadhaar, PAN, bank, medical, salary) unless the caller holds the matching `*.sensitive.read` / payroll permission.
- Sensitive fields are encrypted with `lib/crypto` (AES-256-GCM) and looked up by HMAC. Never log, export, or put them in error messages, audit `before/after` (store `"[REDACTED]"`), notifications, or chatbot context.
- Validate all input with Zod `.strict()` schemas on the server, even when the form already validated it.
- File uploads: use `lib/storage` only — it enforces size limits, magic-byte MIME detection, allowlist, image re-encoding and random keys.
- Webhooks: verify signature on the raw body before parsing; dedupe by gateway event id; never trust client-side payment callbacks.
- Never write secrets, real personal data, or credentials into code, tests, seeds, docs, memory, or commit messages. Seeds use synthetic data only.
- Do not read `.env*` files. Refer to variables by name (docs/ENVIRONMENT_VARIABLES.md).
- Any new endpoint needs an RBAC integration test proving forbidden roles get 403.
- Escalate to the `security-auditor` agent for changes to auth, sessions, RBAC, crypto, uploads, payments, exports or the chatbot.
- Delegated administration: a non–Super Admin may only modify users whose entire permission set they hold (`assertCanModifyUser`), and only grant what they hold (`actorCovers`, partial-order scopes). Never bypass these in new admin features.
- Transactions that can change Super Admin membership must start with `lockSuperAdminGuard(tx)`; do not rely on `SELECT … FOR UPDATE` over joins for invariants (READ COMMITTED re-checks only locked rows).
- Secrets in links (reset, invitations, verification) go in the URL fragment, never the query string; pages strip them from history and POST them.
- Pages stay dynamic (nonce CSP). Never add inline `<script>` without the nonce, never weaken `script-src`, and add new third-party origins to `src/lib/csp.ts` explicitly.
- Public, unauthenticated endpoints must be rate limited and must not touch the database on every request (Neon free-tier compute); cache public data.
