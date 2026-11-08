---
paths:
  - "src/app/**/*.tsx"
  - "src/components/**"
---

# Frontend rules

- Follow docs/UI_UX_GUIDELINES.md. Design at 360px first; verify at 360, 768 and 1280 widths.
- Server Components by default; add `"use client"` only for interactivity. Data fetching happens on the server through services with the user's `AuthContext` — never fetch ERP data from the client with broad endpoints.
- Use shadcn/ui components from `src/components/ui`; don't add another component library.
- Lists use `ResponsiveDataView` (table on desktop, cards on mobile). Long forms are multi-step with a sticky action bar.
- Forms: React Hook Form + the module's Zod schema from `*.schemas.ts` (same schema the server uses).
- No hard-coded school content or brand colours on the public site — read from CMS/settings and CSS variables.
- Images via `next/image` with `sizes`; public pages must stay Lighthouse mobile ≥ 90.
- Accessibility: every input labelled, visible focus, touch targets ≥ 44px, no information conveyed by colour alone.
- `dangerouslySetInnerHTML` only inside the sanitized CMS renderer component.
