import { ConflictError } from "@/lib/errors";

/**
 * Pure classes & sections rules (no I/O — unit tested). Services apply them inside transactions with
 * freshly locked rows. Design: docs/PHASE_2_CLASSES_SECTIONS_DESIGN.md §2, §6; ADR-034.
 * The same limits are CHECK constraints in migration 20261110000000 — keep both in step.
 */
export const CLASS_CODE_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
export const SECTION_NAME_RE = /^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/;
export const LEVEL_MIN = -3;
export const LEVEL_MAX = 12;
export const CAPACITY_MIN = 1;
export const CAPACITY_MAX = 200;
/** Owner decision D3: the school-wide default when nothing else is set (SchoolSetting column default). */
export const DEFAULT_SECTION_CAPACITY = 40;

/** Trim and collapse inner whitespace runs to one space (same as the DB CHECK's regexp_replace). */
export function collapseSpaces(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Case-insensitive uniqueness key. Inputs are ASCII (schemas), so JS toLowerCase() equals SQL lower()
 * and the CHECK `name_key = lower(name)` always holds.
 */
export function nameKeyOf(name: string): string {
  return collapseSpaces(name).toLowerCase();
}

/** "<class code>-<NAME without spaces, uppercased>": ("C06", "Rose Garden") → "C06-ROSEGARDEN". */
export function sectionCodeOf(classCode: string, sectionName: string): string {
  return `${classCode}-${collapseSpaces(sectionName).replace(/ /g, "").toUpperCase()}`;
}

/** Form value → class default → school default (stored on the section; later default changes never alter it). */
export function resolveCapacity(entered: number | null | undefined, classDefault: number | null | undefined, schoolDefault: number | null | undefined): number {
  return entered ?? classDefault ?? schoolDefault ?? DEFAULT_SECTION_CAPACITY;
}

export type SessionStatus = "PLANNED" | "ACTIVE" | "CLOSED";

/** Sections may be created, edited or deleted only in PLANNED and ACTIVE sessions. */
export function assertSessionWritable(status: SessionStatus): void {
  if (status === "CLOSED") throw new ConflictError("This academic session is closed. Its sections are read-only.");
}

export function isSessionWritable(status: SessionStatus): boolean {
  return status !== "CLOSED";
}

/** Capacity can't drop below the students already enrolled. */
export function assertCapacityFits(capacity: number, activeEnrollments: number): void {
  if (capacity < activeEnrollments) {
    throw new ConflictError(`${activeEnrollments} students are enrolled in this section. Capacity can't be less than that.`);
  }
}

/** The class code is a stable import/report key: fixed once any section (any session) uses the class. */
export function assertClassCodeChangeAllowed(currentCode: string, nextCode: string, sectionCount: number): void {
  if (currentCode !== nextCode && sectionCount > 0) {
    throw new ConflictError("The class code can't be changed after sections have been created for this class.");
  }
}

/** The section name (and so its code) is fixed once students are enrolled. */
export function assertSectionRenameAllowed(currentName: string, nextName: string, activeEnrollments: number): void {
  if (currentName !== nextName && activeEnrollments > 0) {
    throw new ConflictError("The section name can't be changed after students have been enrolled.");
  }
}

export function assertOptimisticVersion(current: number, submitted: number, what: "class" | "section"): void {
  if (current !== submitted) throw staleError(what);
}

export function staleError(what: "class" | "section"): ConflictError {
  return new ConflictError(`This ${what} was changed by someone else. Reload the page and try again.`);
}

export interface CopySource {
  classId: string;
  classCode: string;
  classActive: boolean;
  name: string;
  nameKey: string;
  capacity: number;
  isActive: boolean;
}

export interface CopyPlanRow {
  classId: string;
  name: string;
  nameKey: string;
  code: string;
  capacity: number;
}

/**
 * Copy-from-session plan: only ACTIVE sections of ACTIVE classes; name and capacity carried; class
 * teachers NOT copied (a new year needs a fresh assignment, so ASSIGNED access is never re-granted
 * silently); (class, name_key) already present in the target is skipped. Codes use the class's
 * current code. Running the result twice creates nothing the second time.
 */
export function planSectionCopy(source: CopySource[], targetKeys: Iterable<string>): { create: CopyPlanRow[]; skipped: number } {
  const taken = new Set(targetKeys);
  const create: CopyPlanRow[] = [];
  let skipped = 0;
  for (const s of source) {
    if (!s.isActive || !s.classActive) continue;
    const key = targetKey(s.classId, s.nameKey);
    if (taken.has(key)) {
      skipped++;
      continue;
    }
    taken.add(key);
    create.push({ classId: s.classId, name: s.name, nameKey: s.nameKey, code: sectionCodeOf(s.classCode, s.name), capacity: s.capacity });
  }
  return { create, skipped };
}

export function targetKey(classId: string, nameKey: string): string {
  return `${classId}\u0000${nameKey}`;
}

/** Only the fields that changed: `{ before, after }` for the audit log (ids and plain values only). */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): { before: Partial<T>; after: Partial<T> } {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const k of Object.keys(after) as (keyof T)[]) {
    if (after[k] !== undefined && after[k] !== before[k]) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}
