"use client";

/** Generic error boundary: never shows stack traces or internal messages to users. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div role="alert" className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">The service is temporarily unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">Please try again in a moment. If the problem continues, contact the school office.</p>
        {error.digest && <p className="mt-2 text-xs text-slate-500">Reference: {error.digest}</p>}
        <button
          type="button"
          onClick={reset}
          className="mt-4 inline-flex min-h-11 items-center rounded-lg bg-blue-700 px-5 font-semibold text-white hover:bg-blue-800"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
