---
name: school-cms
description: Use when working on the public school website or its CMS — pages, homepage sections and ordering, menus, banners, notices, news, events, gallery, downloads, admission information, contact/map, or publish/revalidation.
---

# School CMS & public website

## Responsibilities
All public content comes from the database, is editable by authorized staff, and only PUBLISHED content is ever shown publicly.

## Model
- `CMSPage(slug)` with ordered `CMSSection(type, order, isVisible, content JSON, status)`.
- Each section type has a Zod schema in `src/modules/cms/sections/<type>.ts` and a renderer component in `src/components/public/sections/`. Adding a section type = schema + renderer + editor form + registry entry.
- Notices, News, Events, Gallery, Downloads, Banners, MenuItems are first-class models with `status` and publish windows.

## Workflows
- Edit (`cms.edit`): saves DRAFT; content validated by section schema; rich text sanitized server-side (allowlist: p, h2–h4, strong, em, ul/ol/li, a[href https/mailto/tel], img[src from storage], table basics).
- Publish (`cms.publish`): set PUBLISHED + `publishedAt`, audit, `revalidateTag("cms:<slug>")` (and `cms:home` for homepage-affecting content).
- Reorder homepage sections: drag-and-drop on desktop, up/down buttons on mobile; saved as a single transaction updating `order`.
- Media: uploads go through `lib/storage` with `visibility = PUBLIC`, re-encoded to WebP/AVIF variants.
- Chatbot sync: publishing admission/contact/timings content may offer "update chatbot knowledge" (creates a CMS_SYNC knowledge draft; never auto-publishes).

## Rules
- No hard-coded school name, address, timings, fees, dates, or images in components — render empty states if CMS data is missing.
- Public queries live in `cms.public.ts` and filter `status = PUBLISHED`, `publishAt <= now`, not expired, not deleted.
- Admission enquiry form: Zod validation, honeypot field, rate limit per IP hash, stored as AdmissionEnquiry, notifies Admission Officers.
- Google Maps: store the embed URL (validated `https://www.google.com/maps/embed?...`) in settings; CSP `frame-src` allowlist.

## Tests
Draft invisible publicly, scheduled publish window respected, sanitizer strips `<script>`/`onerror`/`javascript:`, reorder persists, revalidation called on publish.
