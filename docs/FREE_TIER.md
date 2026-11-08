# Free-Tier Strategy, Limits and Fallbacks

Goal: **zero recurring infrastructure cost during development**, with no path to surprise charges.
Every external service is optional and replaceable; the app keeps working (degraded) when one is absent or exhausted.

Limits below were checked on 2026-11-08 from the providers' own pages where possible. Providers change limits — re-verify before relying on a number, and update this file.

## Cost-protection rules

1. **No payment method on any account** used for this project (Neon, Cloudinary, Resend, hosting). Without a card, providers cannot bill; at their limit they suspend or throttle instead.
2. All metered calls go through `src/lib/usage.ts` → daily caps set **below** provider limits; at 80 % the Super Admin dashboard shows a warning, at 100 % the feature falls back (see table) instead of calling the provider.
3. Optional providers default to `none`/`log` in env. Nothing external is called unless explicitly configured.
4. The ERP dashboard's "Free-tier usage today" panel (permission `usage.read`) shows current consumption; `npm run db:check` shows database size against the storage budget.
5. Never add a paid plugin, paid API, or "trial" that auto-converts to paid.

## Services

| Service | Used for | Free limits (verified) | When exhausted | Fallback / replacement |
|---|---|---|---|---|
| **Neon Postgres (Free)** | Primary database, pgvector | 100 CU-hours/project/month; storage cap per project (the Free plan page lists 0.5–1 GB — we budget **512 MB**); 10 branches; scale-to-zero after 5 min (not configurable); 6 h point-in-time restore (1 GB of changes); 5 GB public egress | Compute suspended until next month; at storage cap writes fail. **No overage billing on Free.** Data not deleted. | Any Postgres 16+ with pgvector (Supabase, self-hosted). Driver adapter is standard `pg` (portable). |
| **Cloudinary (Free)** | **Public** media only: logo, banners, gallery, campus photos | 25 credits/month (≈1 credit = 1 GB storage or 1 GB bandwidth or 1,000 transformations); no card required | Soft limits; uploads may be blocked | `PUBLIC_MEDIA_DRIVER=local` (files served by the app), or any CDN. Images pre-resized on upload to save credits. |
| **Private storage** | Student/staff documents, ID proofs | Development: local disk (`PRIVATE_STORAGE_DRIVER=local`), **encrypted with AES-256-GCM before writing** | n/a | Production options (S3-compatible, app-side encrypted so the provider never sees plaintext): self-hosted disk/MinIO on school server; Backblaze B2 (10 GB free — confirm card requirement at signup); Supabase Storage free (~1 GB, project pauses after 7 days idle). **Never Cloudinary.** |
| **Resend (Free)** | Transactional email (password reset, notifications) | 3,000/month, **100/day**, custom domains limited | Sends rejected | `EMAIL_PROVIDER=log` writes emails to the server log / dev mailbox page; in-app notifications always work. App cap: 90/day. |
| **AI chatbot LLM** | Optional natural-language answers | See "AI provider findings" | n/a | **Default `AI_PROVIDER=none`**: FAQ match + Postgres full-text search over published knowledge, returning the matching passage. Fully functional, no external calls. |
| **Embeddings** | Optional semantic search (pgvector) | Local model via `@huggingface/transformers` (runs in Node, no API, no cost) — Phase 13 | n/a | FTS-only retrieval. |
| **Hosting** | Running the app | See "Hosting findings" | | Portable `next build` standalone server — runs on any Node host. |

## AI provider findings (2026-11-08)

- **Google Gemini API free tier — not suitable.** Its terms (aistudio.google.com/docs/terms) state the API may not be used in a client "directed towards or … likely to be accessed by individuals under the age of 18", and free-tier prompts/responses may be used to improve Google products and read by human reviewers. A school website is likely accessed by students.
- **Groq free tier** — no card required per Groq's community pages; limits vary by model and are shown in the console. **Terms regarding minors and data use must be reviewed by the school before enabling.**
- Any provider is configured through `AI_PROVIDER=openai-compatible` + `AI_BASE_URL` + key, and always behind `AI_DAILY_REQUEST_LIMIT` (default **0** = disabled) plus response caching of FAQ-like questions.
- The chatbot never sends ERP data to any provider; only published public knowledge and the visitor's question.

## Hosting findings (2026-11-08)

| Option | Cost | Production for a school? | Notes |
|---|---|---|---|
| **Vercel Hobby** | Free | **No.** Vercel's docs: "the Hobby plan restricts users to non-commercial, personal use only." | Fine for a developer's personal preview deployments during development. Runtime logs 1 h; 4 active-CPU-hours/month. |
| **Render Free web service** | Free | **No.** Render's docs say not to use free instances for production; spins down after 15 min idle (~1 min cold start); suspended when monthly hours run out. | Usable for demos. |
| **Netlify Free** | Free | Unconfirmed. Community answers say commercial use is allowed; official terms not verified; sites pause when monthly credits run out. | Verify ToS before use. |
| **School-owned server / PC** (+ Cloudflare Tunnel free) | Hardware only | **Yes**, if the school operates it | Most realistic zero-recurring-cost production; needs backups & uptime care. |
| **Oracle Cloud Always Free VM** | Free | Possibly; requires card for identity verification (no charge unless upgraded) | Conflicts with the "no card" rule — owner decision. |

**Recommendation:** develop and preview on free tiers; before go-live the school decides between a school-operated server (zero recurring cost) or a small paid plan. Nothing in the code depends on a specific host.

## Neon compute budget (100 CU-hours/month)

Neon Free suspends compute after 5 idle minutes; anything that queries the DB at least every 5 minutes keeps it awake (~0.25 CU × 720 h ≈ 180 CU-h/month — over the allowance → compute suspended until next month). Mitigations in code: `/api/health` is liveness-only (DB check requires `CRON_SECRET`), the public school name is cached 5 minutes, public token checks are rate limited. Operational rules: point uptime monitors at `/api/health` (no `deep`), run the cleanup cron daily (not every few minutes), and watch Neon's usage page monthly.

## Neon storage budget (512 MB)

Keep large binary data **out of Postgres** (files go to storage, only metadata in DB). Housekeeping crons purge expired sessions, rate-limit buckets, import staging rows (30 days) and chat logs (90 days). `npm run db:check` prints database size against the budget and warns at 80 %.
