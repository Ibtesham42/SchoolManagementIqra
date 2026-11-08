# UI/UX Guidelines

## Principles

1. **Mobile-first, not mobile-shrunk.** Design at 360×640 first, then enhance at `md` (768) and `lg` (1024). Staff mark attendance and collect fees on phones.
2. **Task-first screens.** Each ERP page answers "what does this user need to do now?" — primary action visible without scrolling.
3. **Accessible by default.** WCAG 2.2 AA: contrast ≥ 4.5:1, visible focus, labels on every input, keyboard-operable, `aria-live` for async results, reduced-motion respected.
4. **Branding from settings.** Primary colour, logo and school name come from `SchoolSetting.branding`; components use CSS variables, never hard-coded brand colours.

## Layout

| Surface | Mobile (< 768) | Desktop (≥ 1024) |
|---|---|---|
| Public nav | Sticky header, hamburger → full-height sheet, large tap targets, "Admissions" CTA pinned | Horizontal menu with dropdowns |
| ERP nav | Bottom tab bar (4 role-specific shortcuts + "More") and slide-over sidebar | Collapsible left sidebar grouped by module |
| Lists/tables | Card list (key fields + status badge + overflow menu), filters in a bottom sheet | Data table with sticky header, column visibility, bulk-select |
| Forms | Single column, multi-step with progress for long forms (admission = 5 steps), sticky bottom "Save / Next" bar | Two columns where fields are short; same steps |
| Detail pages | Tabs become a scrollable segmented control | Tabs |
| Dialogs | Bottom sheets | Centered dialogs |

## Implementation notes (Phase 1)

- shadcn/ui CLI 4.23, style `radix-nova`, Radix primitives, lucide icons, `cn` class merger (official shadcn package). Components live in `src/components/ui` (owned code); ERP building blocks in `src/components/erp` (`TextField`, `FormStatus`, `SubmitButton`, `PageHeader`, `ConfirmAction`, `OneTimeSecret`, `NotPermitted`, navigation).
- Touch sizing was changed from the shadcn defaults: buttons, inputs and select triggers are 44 px tall below `sm` (640 px) and compact (36 px) above. Checkbox hit areas are enlarged via the component's `after:` inset.
- Colour: `--destructive` set to red-700 (6.5:1 on white). The shadcn default red-600 measured 4.49:1 and failed WCAG AA for error text (found by axe).
- Fonts: system font stack only — no web-font download at build or run time (works offline, no third-party requests).
- Native `<select>` is used for the permission scope editor (accessible, uses the phone's own picker, works with plain form posts).

## Components (shadcn/ui on Radix)

Button, Input, Select, Combobox (searchable, async), DatePicker (keyboard input allowed — DOB entry by typing), Dialog/Sheet, Tabs, Table + `ResponsiveDataView`, Badge, Toast, Skeleton, EmptyState, FileUpload (camera capture on mobile via `accept="image/*" capture`), ConfirmDialog for destructive actions (type-to-confirm for bulk/finalize).

## Interaction rules

- Touch targets ≥ 44×44 px; 8 px minimum spacing between targets.
- Attendance marking: default all Present, tap to cycle status, one "Submit" — designed for one-handed use.
- Every mutation gives feedback (toast) and is optimistic only when safely reversible.
- Destructive or irreversible actions (finalize roll numbers, approve payroll, cancel receipt) show what will change and require confirmation.
- Empty states explain what to do next; loading uses skeletons, not spinners, for lists.
- Money displayed in `en-IN` format (₹1,23,456.00); dates in `DD MMM YYYY`.
- Masked sensitive fields show `XXXX-XXXX-1234` with a "Reveal" button (permission-gated, audited).

## Public website

- Hero with optimized campus image (`next/image`, AVIF/WebP, responsive `sizes`), LCP < 2.5 s on 4G.
- Section order and visibility come from CMS; each section type is a self-contained component with a Zod content schema.
- Google Maps via lazy-loaded iframe (click-to-load on mobile to save data).
- Chatbot: floating button bottom-right, opens full-screen sheet on mobile.

## Print & PDF

ID cards: CR80 (85.6 × 54 mm), 10 per A4 with crop marks. Certificates/receipts: A4 portrait with school letterhead from settings. Receipts also offer A5 / thermal-80mm variants (configurable).
