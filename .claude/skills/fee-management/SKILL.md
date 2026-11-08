---
name: fee-management
description: Use when working on fee structures, concessions, scholarships, late fees, installments, invoice generation, counter fee collection, online payments, webhooks, receipts, or outstanding/defaulter reports.
---

# Fee management

## Responsibilities
Correct amounts, no duplicate payments, verifiable online payments, immutable receipts.

## Calculation (pure, `src/modules/fees/fee-calc.ts`)
`invoiceTotal = Σ(items) − Σ(concessions applicable per category) + lateFee` with `decimal.js`, rounded half-up to 2 dp at line level. Concessions: percent before fixed, never below zero per line. Late fee from `LateFeeRule` (grace days, flat/per-day/percent, cap) evaluated against the school-local date.

## Workflows
- **Generate invoices** (`fee.structure.manage`): for session + period + classes; one invoice per (student, session, period) enforced by unique index → re-running is idempotent. Transport fee added from StudentTransport stop.
- **Counter collection** (`fee.collect`): transaction → create FeePayment (`paymentNo` via sequence, `idempotencyKey` from the form) → allocate oldest-due first (or user-chosen) → update invoice `paidAmount`/status → FeeReceipt (`receiptNo` via sequence) → audit. Non-cash methods require `transactionRef`, unique per method.
- **Online payment**:
  1. Server creates gateway order for the invoice balance (amount computed server-side) and a PENDING FeePayment.
  2. Client completes checkout; client callback only triggers a server verify of the signature (`order_id|payment_id` HMAC with key secret).
  3. Webhook `/api/webhooks/payments/razorpay`: verify `X-Razorpay-Signature` on the raw body, insert `PaymentGatewayEvent` (unique eventId → replay ignored), mark payment SUCCESS once, allocate, issue receipt.
  4. Whichever of verify/webhook arrives first wins; the other is a no-op (status check in a locked row).
- **Cancel receipt / refund** (`fee.refund`): never delete; mark cancelled with reason, reverse allocations, audit, notify.

## Rules
- Receipts are immutable documents; regenerate the PDF from stored data, never from current fee structure.
- Parents (CHILDREN scope) can view/pay only their children's invoices.
- Reports (outstanding, defaulters, collection by method/day) are read-only queries with `fee.report`.

## Tests
Concession/late-fee math, partial & over-payment, duplicate transactionRef rejected, double-submit with same idempotency key → one payment, invalid webhook signature → 400 and no state change, replayed webhook → no double credit.
