---
name: ui-accessibility
description: Use when building or reviewing any screen for responsiveness and accessibility, or when running a UI audit. Contains the project's verification checklist (desktop/tablet/mobile), touch-target and contrast rules, and the evidence categories used in docs/LOCAL_UI_AUDIT.md.
---

# UI, responsiveness & accessibility

## Rules (UI_UX_GUIDELINES.md has the full set)
- Mobile-first at 360 px; verify at desktop (1280, fine pointer), tablet (iPad, touch) and phone (Pixel 7 / iPhone 14).
- Touch targets ≥ 44 px on touch devices. Compact sizes only with `sm:pointer-fine:` — never plain `sm:` (tablets are touch devices wider than 640 px).
- One `<h1>` and one `<main>` per page; ERP pages render inside the layout's `<main id="main">` (skip link targets it) — don't add another `<main>` in ERP pages or `loading.tsx`.
- Every input labelled (`TextField`); errors via `aria-invalid` + `aria-describedby`; status messages `role="status"`, errors `role="alert"` inside the form.
- Colour contrast ≥ 4.5:1 (`--destructive` is red-700 for that reason); no information by colour alone.
- Every list has an empty state; every async action has a pending label (`SubmitButton`); destructive actions use `ConfirmAction`.
- Dates via `lib/format.ts` (school time zone).

## Verification checklist per screen
1. axe (`@axe-core/playwright`): 0 serious/critical; record moderate findings.
2. No horizontal overflow (`scrollWidth - clientWidth ≤ 0`) at all three viewports.
3. Interactive elements ≥ 44 px on tablet/phone.
4. First Tab lands on a meaningful control with a visible focus ring; dialogs trap focus and Escape closes them.
5. Loading, empty, error and success states each exercised.
6. Screenshots reviewed by a person (or the agent viewing them), not just metrics.

## Reporting evidence (never overstate)
Use four categories: **visually verified** (screenshot reviewed), **functionally verified** (interaction exercised and result observed), **database-dependent – not verified**, **not implemented**. A rendered button is not proof its backend works. Note harness races separately from app bugs (re-test with proper waits before reporting a failure).
