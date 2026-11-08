"use client";

/** Last-resort boundary (errors in the root layout). Must render its own <html>. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", textAlign: "center" }}>
        <h1>The service is temporarily unavailable</h1>
        <p>Please try again in a moment.</p>
        {error.digest && <p style={{ fontSize: "0.75rem", color: "#64748b" }}>Reference: {error.digest}</p>}
      </body>
    </html>
  );
}
