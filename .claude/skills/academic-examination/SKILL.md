---
name: academic-examination
description: Use for Phase 4 academic work — subjects, class-subject mapping, teacher allocation, periods and timetables, academic calendar, homework/assignments, student attendance views, examinations, marks entry, configurable CBSE grading, report cards, result publication and promotion.
---

# Academic & examination management (Roadmap Phase 4)

## Data model (DATABASE_SCHEMA §3, §6, §10; homework/calendar designed at phase start)
- `Subject`, `ClassSubject` (per session; max theory/practical/internal), `TeacherAllocation` (session + section + subject + employee) — the source of teachers' **ASSIGNED** scope.
- `TimetableSlot` has two unique constraints: one subject per section/day/period, and one section per teacher/day/period (no double-booking).
- `StudentAttendance` unique per enrollment per date; statuses PRESENT/ABSENT/LATE/HALF_DAY/EXCUSED.
- `Examination` (status DRAFT → SCHEDULED → MARKS_ENTRY → LOCKED → PUBLISHED) → `ExamSubject` → `ExaminationMarks` (per enrollment) → `ReportCard`.
- Grading is data, not code: `GradeScale`/`GradeBand` (seed a CBSE-style scale; schools configure their own).

## Rules
- Grade/percentage/rank calculation lives in a pure, unit-tested module (`*-calc.ts`) using exact arithmetic; rounding rules documented.
- Marks entry only for ASSIGNED subjects/sections; once LOCKED, changes require `marks.approve` with an audited reason; `result.publish` makes results visible to parents/students.
- Promotion creates next-session enrollments (never edits the old ones) and respects detention decisions.
- Report cards render from stored marks/grades (snapshot), so later scale edits don't change published cards.

## Permissions
`academic.manage`, `timetable.read`, `timetable.manage`, `exam.manage`, `marks.enter` (ASSIGNED), `marks.approve`, `result.read` (scoped), `result.publish`, `reportcard.generate`, `attendance.student.mark|read` (scoped).

## Tests
Grade boundaries per scale, absent vs zero marks, timetable clash rejection, marks-entry scope (teacher can't enter for another section), lock/publish transitions, promotion correctness, report-card PDF content, mobile marks-entry e2e.
