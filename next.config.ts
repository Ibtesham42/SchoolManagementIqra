import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  // Portable deployment: a self-contained Node server that runs on any host (ADR-016).
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@node-rs/argon2", "pg"],
  // KI-056: standalone tracing copies sharp's .node binary but not the libvips shared libraries it loads
  // (Windows: libvips-42.dll, libvips-cpp-*.dll; Linux: the separate @img/sharp-libvips-* package), so
  // sharp failed to load in .next/standalone. Include the installed @img platform packages for the API
  // routes that process photos. Only the platforms npm installed are present (build on the target OS).
  outputFileTracingIncludes: {
    "/api/v1/**": ["./node_modules/@img/**/*"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
