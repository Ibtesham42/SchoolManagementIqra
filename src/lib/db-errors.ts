/**
 * Unique-violation detection for Prisma (P2002) and the raw pg driver (23505).
 *
 * Which field conflicted is taken from, in order:
 *   1. `meta.target` — Prisma's column list (or a constraint name, in some versions);
 *   2. `meta.driverAdapterError.cause.constraint` — the pg driver adapter reports either
 *      `{ fields: [...] }` or `{ index: "<constraint name>" }` (the usual case, e.g. user_email_key);
 *   3. raw pg errors — `detail` ("Key (email)=(…) already exists.") or `constraint`.
 * A constraint name is matched against Postgres' default naming `<table>_<column>_key`.
 *
 * KI-045: when the conflicting field cannot be determined, a field-specific check returns FALSE —
 * the caller then rethrows instead of showing a wrong message (it used to return true for every
 * field, so an email clash was reported as "That username is already taken.").
 */

interface UniqueViolationInfo {
  /** Conflicting column names, when known. */
  fields?: string[];
  /** Constraint/index name, when known (e.g. "user_email_key"). */
  constraint?: string;
  /** Table name, when known (narrows constraint-name matching). */
  table?: string;
}

type ErrorShape = {
  code?: unknown;
  meta?: {
    target?: unknown;
    modelName?: unknown;
    driverAdapterError?: { cause?: { constraint?: { fields?: unknown; index?: unknown }; table?: unknown } };
  };
  constraint?: unknown;
  detail?: unknown;
  table?: unknown;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const strArray = (v: unknown): string[] | undefined => (Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);

/** camelCase or snake_case → snake_case column name ("passwordHash" → "password_hash"). */
const column = (field: string) => field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Pure: everything known about a unique violation, or null if `e` is not one. */
export function uniqueViolationInfo(e: unknown): UniqueViolationInfo | null {
  if (!e || typeof e !== "object") return null;
  const err = e as ErrorShape;
  if (err.code !== "P2002" && err.code !== "23505") return null;
  const info: UniqueViolationInfo = {};

  const target = err.meta?.target;
  const targetList = strArray(target);
  const targetString = str(target);
  if (targetList) info.fields = targetList;
  else if (targetString) {
    if (/_key$|_unique$|_idx$/.test(targetString)) info.constraint = targetString;
    else info.fields = [targetString];
  }

  const cause = err.meta?.driverAdapterError?.cause;
  const adapterFields = strArray(cause?.constraint?.fields);
  if (!info.fields && adapterFields) info.fields = adapterFields;
  if (!info.constraint) info.constraint = str(cause?.constraint?.index);
  info.table = str(cause?.table);

  // Raw pg error (e.g. from $queryRaw or the pg client).
  if (!info.fields) {
    const fromDetail = str(err.detail)?.match(/Key \(([^)]+)\)=/)?.[1]?.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (fromDetail?.length) info.fields = fromDetail;
  }
  if (!info.constraint) info.constraint = str(err.constraint);
  if (!info.table) info.table = str(err.table);
  return info;
}

/** Postgres default unique-constraint name for one column: <table>_<column>_key. */
function constraintCovers(constraint: string, col: string, table?: string): boolean {
  if (table) return constraint === `${table}_${col}_key`;
  return constraint.endsWith(`_${col}_key`);
}

/**
 * True if `e` is a unique violation — and, when `field` is given, only if that field is KNOWN to be
 * the one that conflicted. Unknown → false (never guess).
 */
export function isUniqueViolation(e: unknown, field?: string): boolean {
  const info = uniqueViolationInfo(e);
  if (!info) return false;
  if (!field) return true;
  const col = column(field);
  if (info.fields) return info.fields.some((f) => column(f) === col);
  if (info.constraint) return constraintCovers(info.constraint, col, info.table);
  return false;
}

/** A multi-column (or partial) unique index: its exact name and its full column list. */
export interface UniqueIndex {
  /** Index/constraint name as created by the migration, e.g. "section_session_class_teacher_key". */
  index: string;
  /** Every column of the index (camelCase or snake_case; order does not matter). */
  fields: string[];
}

/**
 * True only if `e` is a unique violation KNOWN to come from `idx`: the reported constraint name equals
 * `idx.index`, or the reported column set is exactly `idx.fields`. Partial or unknown information →
 * false, so the caller rethrows instead of showing a wrong message (KI-045). Composite and partial
 * indexes don't follow `<table>_<column>_key`, which `isUniqueViolation(e, field)` relies on.
 */
export function isUniqueViolationOf(e: unknown, idx: UniqueIndex): boolean {
  const info = uniqueViolationInfo(e);
  if (!info) return false;
  if (info.constraint) return info.constraint === idx.index;
  if (info.fields) {
    const got = new Set(info.fields.map(column));
    const want = new Set(idx.fields.map(column));
    return got.size === want.size && [...want].every((c) => got.has(c));
  }
  return false;
}

/**
 * True when a transaction failed because the system was busy rather than because of the data:
 *  - Prisma P2028 (interactive transaction couldn't start within maxWait, or ran past its timeout);
 *  - Postgres 55P03 lock_not_available (our per-transaction lock_timeout) and 40P01 deadlock_detected
 *    (Postgres rolled one transaction back; retrying is safe);
 *  - the pg driver adapter's TransactionAlreadyClosed / lock-timeout wording.
 * These become ServiceBusyError ("try again") — never a data error, never Prisma's message.
 */
export function isTransactionBusy(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: unknown; message?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } } };
  if (err.code === "P2028" || err.code === "55P03" || err.code === "40P01") return true;
  const cause = err.meta?.driverAdapterError?.cause;
  if (cause && (cause.originalCode === "55P03" || cause.originalCode === "40P01" || cause.kind === "TransactionAlreadyClosed")) return true;
  const msg = typeof err.message === "string" ? err.message : "";
  return /Unable to start a transaction in the given time|Transaction already closed|canceling statement due to lock timeout|deadlock detected/i.test(msg);
}
