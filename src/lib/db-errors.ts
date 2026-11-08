/** Postgres unique violation surfaced by Prisma (P2002) or the pg driver (23505). */
export function isUniqueViolation(e: unknown, field?: string): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } } };
  if (err.code !== "P2002" && err.code !== "23505") return false;
  if (!field) return true;
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target : typeof target === "string" ? [target] : err.meta?.driverAdapterError?.cause?.constraint?.fields;
  return !fields || fields.some((f) => String(f).includes(field));
}
