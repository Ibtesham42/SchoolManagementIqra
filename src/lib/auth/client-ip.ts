/**
 * Client IP for rate limiting, hashed. The LEFTMOST X-Forwarded-For entry is client-controlled
 * and spoofable, so we take the entry appended by our own proxy: the one TRUSTED_PROXY_HOPS
 * positions from the right (default 1 = the address seen by the nearest proxy).
 */
export function pickClientIp(forwardedFor: string | null, realIp: string | null, trustedHops: number): string {
  const chain = (forwardedFor ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (chain.length > 0 && trustedHops > 0) return chain[Math.max(0, chain.length - trustedHops)];
  return realIp?.trim() || "unknown";
}
