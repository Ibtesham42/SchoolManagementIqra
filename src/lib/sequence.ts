import type { Tx } from "@/lib/db";

/**
 * Concurrency-safe counters (ADR-007). Must be called inside the caller's transaction:
 * the upsert takes a row lock, so concurrent callers serialize, and a rolled-back
 * transaction also rolls back the increment (no duplicates, no gaps from failures).
 */
export async function nextSequence(tx: Tx, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO sequence_counter (key, value, updated_at) VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET value = sequence_counter.value + 1, updated_at = now()
    RETURNING value`;
  const value = rows[0]?.value;
  if (typeof value !== "number") throw new Error(`Sequence ${key} did not return a value`);
  return value;
}

export interface FormatTokens {
  code?: string;
  year?: number;
  session?: string;
  className?: string;
}

const TOKEN = /\{(CODE|YYYY|YY|SESSION|CLASS|SEQ(?::(\d+))?)\}/g;

/** Validates that a format contains exactly one {SEQ} token and only known tokens. */
export function validateFormat(format: string): string | null {
  const seqCount = (format.match(/\{SEQ(?::\d+)?\}/g) ?? []).length;
  if (seqCount !== 1) return "Format must contain exactly one {SEQ} or {SEQ:n} token";
  const unknown = format.replace(TOKEN, "").match(/\{[^}]*\}/);
  if (unknown) return `Unknown token ${unknown[0]}`;
  return null;
}

/**
 * Renders e.g. "{CODE}-{YYYY}-{SEQ:4}" → "JNV-2026-0001".
 * Numbers beyond the padding width are never truncated (10000 stays 10000).
 */
export function formatSequence(format: string, seq: number, tokens: FormatTokens): string {
  const error = validateFormat(format);
  if (error) throw new Error(error);
  return format.replace(TOKEN, (_m, name: string, width?: string) => {
    switch (name) {
      case "CODE":
        return required(tokens.code, "CODE");
      case "YYYY":
        return String(required(tokens.year, "YYYY"));
      case "YY":
        return String(required(tokens.year, "YY")).slice(-2);
      case "SESSION":
        return required(tokens.session, "SESSION");
      case "CLASS":
        return required(tokens.className, "CLASS");
      default:
        return String(seq).padStart(width ? Number(width) : 1, "0");
    }
  });
}

/** Counter key covering every token that should reset the counter. */
export function sequenceKey(base: string, format: string, tokens: FormatTokens): string {
  const parts = [base];
  if (/\{YYYY\}|\{YY\}/.test(format)) parts.push(String(tokens.year));
  if (format.includes("{SESSION}")) parts.push(String(tokens.session));
  if (format.includes("{CLASS}")) parts.push(String(tokens.className));
  return parts.length === 1 ? `${base}:all` : parts.join(":");
}

function required<T>(value: T | undefined, token: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`Missing value for {${token}}`);
  return value;
}
