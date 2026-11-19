import type { Tx } from "@/lib/db";

/**
 * Transaction helpers of the students module that other modules call (no authorization — the caller authorized its
 * own operation and holds the locks it documents).
 */

/** Student attendance recorded on a date (holiday writes refuse such dates; the caller holds the calendar lock). */
export async function studentAttendanceCountOnTx(tx: Tx, date: Date): Promise<number> {
  return tx.studentAttendance.count({ where: { date } });
}

/** Distinct dates with student attendance in sessions that aren't CLOSED (weekly-off changes; bounded by session days). */
export async function openSessionAttendanceDatesTx(tx: Tx): Promise<string[]> {
  const rows = await tx.$queryRaw<{ date: Date }[]>`
    SELECT DISTINCT sa.date FROM student_attendance sa
    JOIN academic_session s ON s.id = sa.academic_session_id
    WHERE s.status <> 'CLOSED'`;
  return rows.map((r) => r.date.toISOString().slice(0, 10));
}
