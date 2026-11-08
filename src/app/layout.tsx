import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "School", template: "%s · School" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

/**
 * Every page renders per request. Required by the nonce-based Content-Security-Policy (src/proxy.ts):
 * a statically prerendered page can't carry the per-request nonce, so its scripts would be blocked.
 * It also guarantees authenticated/sensitive pages are never served from a shared cache.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="font-sans">
      <body className="font-sans text-slate-900 antialiased">{children}</body>
    </html>
  );
}
