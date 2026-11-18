---
name: nextjs-standards
description: Use when creating or changing pages, layouts, server actions, route handlers, loading/error/not-found files, the proxy, or client components in this Next.js 16 app. Covers the project's App Router conventions, CSP/dynamic rendering constraints and React 19 lint rules.
---

# Next.js 16 standards (this project)

Next 16 differs from older versions: `middleware.ts` is now **`src/proxy.ts`** (`export function proxy`), and `next dev` writes an `AGENTS.md` pointing to `node_modules/next/dist/docs/`. Read those docs for any API you're unsure about.

## Rendering & security constraints
- **Every page renders dynamically** (`export const dynamic = "force-dynamic"` in the root layout) because the nonce-based CSP (`src/proxy.ts`, `src/lib/csp.ts`) can't apply to prerendered pages. Never add `force-static`; cache *data* (see `modules/settings/settings.public.ts`) instead of pages.
- No inline `<script>`; add third-party origins to `lib/csp.ts` explicitly (with security review).
- Pages must not call `Date.now()`/random during render (React 19 purity lint) — compute in services.

## Pages (Server Components)
```tsx
export default async function Page() {
  const ctx = await requireAuth();                       // session + forced-password-change redirect
  if (!hasPermission(ctx, "user.read")) return <NotPermitted />;  // presentation only
  const data = await listUsers(ctx, input);              // service re-authorizes
  return <PageHeader title="Users" /* … */ />;
}
```
- `requireAuth({ allowPendingPasswordChange: true })` only on the change-password page/action.
- `notFound()` for missing records (global `app/not-found.tsx`); `app/erp/loading.tsx` shows the skeleton; `app/error.tsx` shows a reference id only.
- Parse `searchParams` with `safeParse` and fall back to defaults (malformed URLs mustn't error).

## Server actions
- File starts with `"use server"` and exports **only async functions** (constants go in a separate module, e.g. `modules/identity/messages.ts`).
- Signature `(prev: ActionState, formData: FormData) => Promise<ActionState>`; call `requireAuth()` first; validate with the module's Zod schema (`fromZod`); call the service; map errors with `fromError`; call `redirect()` **outside** `try/catch`.
- Work that must not affect response timing (e.g. reset emails) goes in `after()` from `next/server`.

## Client components
- `useActionState` + `components/erp/form.tsx` (`TextField`, `FormStatus`, `SubmitButton`) and `ConfirmAction` for destructive actions.
- Don't `setState` synchronously inside `useEffect` (lint error); close dialogs from the action wrapper instead.
- Secrets in links (reset tokens) are read from `location.hash` and stripped with `history.replaceState`.

## Layer rules (lint + `npm run check:deps`)
`components/**` → no `@/app`, no `@/modules`. `lib/**` → nothing above it. Shared UI config lives in `components/` (e.g. `nav-items.ts`).
