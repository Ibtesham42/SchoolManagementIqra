/** Pure free-tier usage rules, shared by lib/usage (DB) and the usage dashboard. */
export const WARN_RATIO = 0.8;

export type UsageLevel = "ok" | "warning" | "exhausted";

export function levelFor(used: number, cap: number): UsageLevel {
  if (cap <= 0 || used >= cap) return "exhausted";
  return used >= cap * WARN_RATIO ? "warning" : "ok";
}
