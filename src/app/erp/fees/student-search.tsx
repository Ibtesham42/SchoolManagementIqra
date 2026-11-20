/** GET search for a student in the chosen session (server-rendered; no client state). */
export function StudentSearch({ action, session, q }: { action: string; session: string; q: string }) {
  return (
    <form method="get" action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <input type="hidden" name="session" value={session} />
      <label className="grid gap-1.5 text-sm font-medium" htmlFor="fee-q">
        Find a student (name, student ID or admission number)
        <input id="fee-q" name="q" defaultValue={q} minLength={2} maxLength={100} required className="h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm" />
      </label>
      <button type="submit" className="min-h-11 rounded-lg border px-4 text-sm font-medium hover:bg-muted">
        Search
      </button>
    </form>
  );
}
