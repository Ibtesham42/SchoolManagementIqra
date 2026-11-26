/** Phase 6C-M1 — fixed wording for notice states, audiences and reach (staff screens). */
export const STATE_LABEL = { DRAFT: "Draft", SCHEDULED: "Scheduled", LIVE: "Published", EXPIRED: "Expired", WITHDRAWN: "Withdrawn" } as const;
export const AUDIENCE_LABEL = { FAMILIES: "Families", PARENTS: "Parents only", STAFF: "Staff", ALL: "Families and staff" } as const;
export const SCOPE_LABEL = { SCHOOL: "Whole school", CLASS: "Classes", SECTION: "Sections" } as const;
export const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
