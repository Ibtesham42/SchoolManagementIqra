/**
 * Content-Security-Policy builder (pure; unit tested). Applied per request by src/proxy.ts with a
 * fresh nonce; Next.js reads the nonce from the request's CSP header and adds it to its own scripts.
 *
 *  - script-src: nonce + 'strict-dynamic' — only scripts the server emitted (and what they load) run.
 *    No 'unsafe-inline'. Development also needs 'unsafe-eval' for React Refresh.
 *  - style-src 'unsafe-inline': Radix/Tailwind set inline style attributes; styles can't run code.
 *  - img-src: self, data:/blob: (previews), Cloudinary for public media (ADR-018).
 *  - frame-src 'none' for now; Phase 2 adds the Google Maps embed origin explicitly.
 */
export function buildCsp({ nonce, dev, https }: { nonce: string; dev: boolean; https: boolean }): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
    "font-src": ["'self'"],
    "connect-src": ["'self'", ...(dev ? ["ws:"] : [])],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "base-uri": ["'none'"],
    "object-src": ["'none'"],
    "manifest-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (https) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** 128-bit random nonce, base64 (Web Crypto: works in the proxy runtime). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
