---
paths:
  - "src/app/**/*.tsx"
  - "src/components/**"
---

# Frontend rules

- Follow docs/UI_UX_GUIDELINES.md. Design at 360px first; verify at 360, 768 and 1280 widths.
- Server Components by default; add `"use client"` only for interactivity. Data fetching happens on the server through services with the user's `AuthContext` — never fetch ERP data from the client with broad endpoints.
- Use shadcn/ui components from `src/components/ui`; don't add another component library.
- Lists render a table from `md` up and a card list below it (pattern: `app/erp/users/page.tsx`); there is no shared `ResponsiveDataView` component yet. Long forms are multi-step with a sticky action bar.
- Controls are 44 px on touch devices; compact sizes only with `sm:pointer-fine:` (UI_UX_GUIDELINES). Format dates with `lib/format.ts` (school time zone), never bare `toLocale*`.
- `src/components/**` may not import `@/app` or `@/modules` (lint-enforced): pages fetch data and pass props.
- Forms: server actions + `useActionState` returning `ActionState` (`lib/action-state.ts`), rendered with `TextField`/`FormStatus`/`SubmitButton` from `components/erp/form.tsx`; the action validates with the module's Zod schema. (React Hook Form is not installed — add it only if a form genuinely needs client-side state.)
- No hard-coded school content or brand colours on the public site — read from CMS/settings and CSS variables.
- Images via `next/image` with `sizes`; public pages must stay Lighthouse mobile ≥ 90.
- Accessibility: every input labelled, visible focus, touch targets ≥ 44px, no information conveyed by colour alone.
- `dangerouslySetInnerHTML` only inside the sanitized CMS renderer component.
