/**
 * Pure Phase 4C promotion rules (no I/O — unit tested). PHASE_4_PLAN.md AC16.
 *
 * - PROMOTE moves a student to an active class one numeric level up (-3 … 0 pre-primary, then 1–12). Several classes
 *   can share a level (streams, e.g. 11 Science / 11 Commerce): the screen must make the user choose — never a guess.
 * - DETAIN keeps the same class in the next session. LEAVE creates no next enrollment.
 * - From the highest level there is no class to promote to: the student completes school (status change, not an
 *   enrollment).
 * Promotion only creates next-session enrollments; old enrollments are never edited (service, one transaction per batch).
 */
export interface ClassOption {
  id: string;
  name: string;
  numericLevel: number;
  displayOrder: number;
  isActive: boolean;
}

export type NextClass =
  | { kind: "one"; classId: string }
  | { kind: "choose"; classIds: string[] }
  | { kind: "completes" }
  | { kind: "none_configured"; level: number };

export const MAX_LEVEL = 12;

export function nextClassFor(classes: readonly ClassOption[], current: ClassOption): NextClass {
  if (current.numericLevel >= MAX_LEVEL) return { kind: "completes" };
  const level = current.numericLevel + 1;
  const options = classes
    .filter((c) => c.isActive && c.numericLevel === level)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  if (options.length === 0) return { kind: "none_configured", level };
  if (options.length === 1) return { kind: "one", classId: options[0].id };
  return { kind: "choose", classIds: options.map((c) => c.id) };
}

export type PromotionDecision = "PROMOTE" | "DETAIN" | "LEAVE";

/** Target class for a decision, or the reason none can be derived. `chosenClassId` is the user's pick for streams. */
export function targetClass(
  classes: readonly ClassOption[],
  current: ClassOption,
  decision: PromotionDecision,
  chosenClassId: string | null,
): { ok: true; classId: string | null } | { ok: false; reason: "choose_class" | "invalid_choice" | "no_next_class" | "completes" | "class_inactive" } {
  if (decision === "LEAVE") return { ok: true, classId: null };
  if (decision === "DETAIN") return current.isActive ? { ok: true, classId: current.id } : { ok: false, reason: "class_inactive" };
  const next = nextClassFor(classes, current);
  if (next.kind === "completes") return { ok: false, reason: "completes" };
  if (next.kind === "none_configured") return { ok: false, reason: "no_next_class" };
  if (next.kind === "one") return chosenClassId === null || chosenClassId === next.classId ? { ok: true, classId: next.classId } : { ok: false, reason: "invalid_choice" };
  if (chosenClassId === null) return { ok: false, reason: "choose_class" };
  return next.classIds.includes(chosenClassId) ? { ok: true, classId: chosenClassId } : { ok: false, reason: "invalid_choice" };
}

const REASON: Record<"choose_class" | "invalid_choice" | "no_next_class" | "completes" | "class_inactive", string> = {
  choose_class: "Choose which class (stream) the student moves to.",
  invalid_choice: "That class isn't the next class for this student.",
  no_next_class: "No active class exists at the next level. Create it first.",
  completes: "This is the highest class: choose Leave (graduated) instead of Promote.",
  class_inactive: "This class is inactive, so the student can't be detained in it.",
};

/** A proposal's problem (user-facing), or the target class (null for LEAVE). */
export function decisionProblem(
  classes: readonly ClassOption[],
  current: ClassOption,
  entry: { decision: PromotionDecision; toClassId: string | null; leaveAs: string | null },
): { ok: true; classId: string | null } | { ok: false; message: string } {
  if (entry.decision === "LEAVE") {
    if (!entry.leaveAs) return { ok: false, message: "Say why the student leaves: transferred, withdrawn or graduated." };
    return { ok: true, classId: null };
  }
  if (entry.leaveAs) return { ok: false, message: "A leaving status only goes with Leave." };
  const t = targetClass(classes, current, entry.decision, entry.decision === "DETAIN" ? null : entry.toClassId);
  return t.ok ? t : { ok: false, message: REASON[t.reason] };
}

/**
 * Confirmation turns the old enrollments into PROMOTED / DETAINED / LEFT, which takes students off this session's
 * rosters (marks, attendance). So it is allowed only from the session's last day (school-local ISO dates).
 */
export function confirmTimingProblem(today: string, sessionEnd: string): string | null {
  return today < sessionEnd ? `Promotions can be confirmed from the session's last day (${sessionEnd}).` : null;
}

/** The next session must start after the current one ends and still be open. */
export function targetSessionProblem(source: { endDate: string }, target: { startDate: string; status: string }): string | null {
  if (target.status === "CLOSED") return "The next session is closed.";
  if (target.startDate <= source.endDate) return "Choose a session that starts after this one ends.";
  return null;
}
