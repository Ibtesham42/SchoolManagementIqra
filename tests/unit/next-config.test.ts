import { describe, expect, it } from "vitest";
import config from "../../next.config";

/**
 * KI-056 guard: Next.js standalone tracing copies sharp's .node binary but not the libvips shared
 * libraries it loads, so sharp failed to load in .next/standalone (verified 2026-11-10). The config must
 * keep including the installed @img platform packages for the API routes that process photos.
 */
describe("next.config (standalone output)", () => {
  it("builds a standalone server", () => {
    expect(config.output).toBe("standalone");
  });
  it("traces sharp's native platform packages (libvips) into the standalone output for /api/v1 routes", () => {
    expect(config.outputFileTracingIncludes?.["/api/v1/**"]).toContain("./node_modules/@img/**/*");
  });
});
