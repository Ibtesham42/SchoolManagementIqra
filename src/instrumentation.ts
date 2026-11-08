/**
 * Runs once when the server starts (not during `next build`).
 * Fails fast on missing/invalid configuration instead of erroring on first use.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("@/lib/env");
    getEnv();
  }
}
