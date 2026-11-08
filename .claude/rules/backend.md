---
paths:
  - "src/modules/**"
  - "src/lib/**"
  - "src/app/api/**"
  - "src/chatbot/**"
---

# Backend rules

- Module layout: `<name>.service.ts` (business logic, the only mutation path), `<name>.schemas.ts` (Zod), `<name>.policy.ts` (record scopes), `<name>.serializers.ts` (response shaping).
- Service signature: `async function verbNoun(ctx: AuthContext, input: ParsedInput, deps?)`. Pure calculations (fees, payroll, grades, roll numbers) live in separate side-effect-free files so they are unit-testable.
- Throw `AppError` subclasses; never return error strings. Route handlers use `withRoute()` from `lib/http` to map errors, attach request id and rate-limit.
- Write `audit(tx, {...})` inside the same transaction as the change it records.
- Notifications are enqueued after commit, never inside the transaction.
- Money math with `decimal.js`; round only at defined points (line totals, final amount) with `ROUND_HALF_UP` to 2 decimals.
- Time: use the school timezone from settings for "today" (attendance, due dates); store instants in UTC.
- Keep endpoints documented in docs/API_DOCUMENTATION.md as they ship.
- Run `npm run check:deps` after adding modules; layer rules are also enforced by ESLint.
- Long CPU work (Argon2 hashing, PDF rendering) happens outside interactive transactions; re-verify state under lock inside the transaction.
