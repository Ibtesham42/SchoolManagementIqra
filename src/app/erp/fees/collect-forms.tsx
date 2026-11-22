"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { collectPaymentAction, searchCollectionAction, type CollectionSearchState } from "./actions";

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CARD", label: "Card" },
] as const;

/** Student search for the counter — POSTed, so names never go into a URL. */
export function CollectionSearch() {
  const [state, action] = useActionState<CollectionSearchState, FormData>(searchCollectionAction, initialState);
  const [q, setQ] = useState("");
  return (
    <div className="grid gap-3">
      <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <TextField id="collect-q" label="Find a student (name, student ID or admission number)" name="q" value={q} onChange={(e) => setQ(e.target.value)} minLength={2} maxLength={100} required error={state.fieldErrors?.q} />
        <SubmitButton className="min-h-11" pendingLabel="Searching…">
          Search
        </SubmitButton>
      </form>
      {state.error && <FormStatus state={state} />}
      {state.message && <p className="text-sm text-muted-foreground">{state.message}</p>}
      {state.results && state.results.length > 0 && (
        <ul className="grid gap-2">
          {state.results.map((r) => (
            <li key={r.studentId}>
              <Link href={`/erp/fees/collect/${r.studentId}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm hover:bg-muted">
                <span className="font-medium">{r.fullName}</span>
                <span className="text-muted-foreground">
                  {r.studentCode} · {r.className} {r.sectionCode}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The counter form (FC8–FC11, FC15): amount, method chips, reference, date; optional invoice choice and late-fee waiver. */
export function CollectForm({
  studentId,
  idempotencyKey,
  today,
  earliest,
  totalDue,
  invoices,
  canWaive,
}: {
  studentId: string;
  idempotencyKey: string;
  today: string;
  earliest: string;
  totalDue: string;
  invoices: { id: string; label: string; lateFee: string }[];
  canWaive: boolean;
}) {
  const [state, action] = useActionState(collectPaymentAction, initialState);
  const [method, setMethod] = useState("CASH");
  const [amount, setAmount] = useState(totalDue);
  const [ref, setRef] = useState("");
  const [bank, setBank] = useState("");
  const [chequeDate, setChequeDate] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [reason, setReason] = useState("");
  const withLate = invoices.filter((i) => i.lateFee !== "0.00");
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <TextField id="c-amount" label="Amount received (₹)" name="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required className="h-14 text-2xl tabular-nums" error={state.fieldErrors?.amount} />
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Paid by</legend>
        <div className="flex flex-wrap gap-2">
          {METHODS.map((m) => (
            <label key={m.value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm has-checked:border-primary has-checked:bg-primary/10">
              <input type="radio" name="method" value={m.value} checked={method === m.value} onChange={() => setMethod(m.value)} className="size-4 accent-primary" />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
      {method !== "CASH" && (
        <TextField id="c-ref" label={method === "CHEQUE" ? "Cheque number" : method === "CARD" ? "Card slip / approval number" : "UTR / transaction number"} name="transactionRef" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={60} required error={state.fieldErrors?.transactionRef} />
      )}
      {method === "CHEQUE" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="c-bank" label="Bank" name="bankName" value={bank} onChange={(e) => setBank(e.target.value)} maxLength={80} required error={state.fieldErrors?.bankName} />
          <TextField id="c-cdate" label="Cheque date" name="instrumentDate" type="date" value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} required error={state.fieldErrors?.instrumentDate} />
        </div>
      )}
      <TextField id="c-date" label="Payment date" name="paidOn" type="date" min={earliest} max={today} hint="Up to 7 days back; the late fee is always worked out for today." value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required error={state.fieldErrors?.paidOn} />
      {invoices.length > 1 && (
        <details className="rounded-lg border p-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Pay only some invoices (otherwise oldest first)</summary>
          <div className="mt-3 grid gap-2">
            {invoices.map((i) => (
              <label key={i.id} className="flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary">
                <input type="checkbox" name="invoiceId" value={i.id} className="size-5 accent-primary" />
                {i.label}
              </label>
            ))}
          </div>
        </details>
      )}
      {canWaive && withLate.length > 0 && (
        <details className="rounded-lg border p-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Waive a late fee (on an invoice this payment pays)</summary>
          <div className="mt-3 grid gap-2">
            {withLate.map((i) => (
              <label key={i.id} className="flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary">
                <input type="checkbox" name="waiveLateFee" value={i.id} className="size-5 accent-primary" />
                {i.label} — late fee ₹{i.lateFee}
              </label>
            ))}
            <TextField id="c-wreason" label="Why (seen by fee staff only)" name="waiveReason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} error={state.fieldErrors?.waiveReason} />
          </div>
        </details>
      )}
      <FormStatus state={state} />
      {state.ok ? (
        // After a receipt, never offer the same button again: a full reload brings a fresh form and fresh dues.
        <a href={`/erp/fees/collect/${studentId}`} className="flex min-h-12 items-center justify-center rounded-lg border text-base font-medium hover:bg-muted">
          Record another payment
        </a>
      ) : (
        <div className="sticky bottom-0 -mx-1 bg-background/95 px-1 py-2">
          <SubmitButton className="min-h-12 w-full text-base" pendingLabel="Recording…">
            Collect ₹{amount || "0"}
          </SubmitButton>
        </div>
      )}
    </form>
  );
}
