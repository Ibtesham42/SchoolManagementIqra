---
name: roll-number-generation
description: Use when implementing or changing roll number generation, preview, regeneration, finalization or correction for a class section, or the alphabetical sorting rule.
---

# Roll-number generation

## Responsibilities
Assign roll numbers per (academic session, section) in ascending alphabetical order of full name, with preview → finalize → controlled correction.

## Pure ordering function (`src/modules/students/roll-number.ts`)
```ts
const collator = new Intl.Collator("en-IN", { sensitivity: "base", numeric: true, ignorePunctuation: true });
export function orderForRollNumbers(rows: { enrollmentId: string; fullName: string; dob: Date; studentCode: string }[]) {
  return [...rows]
    .sort((a, b) =>
      collator.compare(normalizeName(a.fullName), normalizeName(b.fullName)) ||
      a.dob.getTime() - b.dob.getTime() ||          // tie-break 1: older first (configurable)
      a.studentCode.localeCompare(b.studentCode))   // tie-break 2: deterministic
    .map((r, i) => ({ ...r, rollNumber: i + 1 }));
}
// normalizeName: trim, collapse whitespace, NFC
```
Sort in the application, not SQL, so results don't depend on DB collation.

## Workflow
1. **Preview** (`rollnumber.generate`): load ACTIVE enrollments for the section → `orderForRollNumbers` → return list. No writes.
2. **Generate** (`rollnumber.generate`): in a transaction, upsert `RollNumberBatch(session, section)` with status DRAFT (reject if FINALIZED), delete existing draft StudentRollNumber rows, insert new ones, bump `version`, audit.
3. **Finalize** (`rollnumber.finalize`): transaction with `SELECT … FOR UPDATE` on the batch; verify the draft still matches current active enrollments (else ConflictError "re-generate first"); set FINALIZED, `isFinal = true`, audit.
4. **Late admission after finalization**: append next number (`max + 1`) — never renumber a finalized section automatically.
5. **Correction** (`rollnumber.correct`): explicit per-student change or full re-sort with a mandatory reason; audit before/after for every changed row; notify class teacher.

## Rules
- Per session and section, independently. Case-insensitive, accent-insensitive.
- Never touch `studentCode` / `admissionNo`.
- Withdrawn students keep their number in a finalized batch (no reshuffle); their number is not reused that session.
- UI: preview table → "Finalize" with type-to-confirm; mobile shows a card list.

## Example
Input: `Rohit Singh`, `amit kumar`, `Zoya Ahmed`, `Ananya Das`, `Rahul Sharma` → 1 amit kumar, 2 Ananya Das, 3 Rahul Sharma, 4 Rohit Singh, 5 Zoya Ahmed.

## Tests
Ordering (case, accents, extra spaces, identical names), preview has no side effects, finalize locks, generate on finalized → ConflictError, correction audited, IDs unchanged.
