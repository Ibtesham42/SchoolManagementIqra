import type { Tx } from "@/lib/db";

/**
 * One transaction-scoped advisory lock for fee SETUP (PHASE_5_PLAN.md §2): category, installment, structure, late-fee
 * and concession writes, invoice generation and invoice cancellation take it FIRST, so a structure can't change while
 * a class is being billed. Collection takes a per-student lock instead (5B). Lock order: fee setup → student → invoice
 * rows → sequence.
 */
export async function lockFeeSetup(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('school_erp.fees.setup'))) AS l`;
}

/**
 * Per-student advisory lock (5B): collection takes it first; re-pricing takes it AFTER the fee-setup lock (review 5B-M1
 * L3). Order everywhere: fee setup → student → invoice rows → sequence. Collection never takes the setup lock.
 */
export async function lockFeeStudent(tx: Tx, studentId: string): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${`school_erp.fees.student:${studentId}`}))) AS l`;
}
