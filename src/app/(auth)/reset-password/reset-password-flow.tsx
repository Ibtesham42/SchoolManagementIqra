"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { checkResetTokenAction } from "../password-reset-actions";
import { ResetPasswordForm } from "./reset-password-form";

type State = { status: "checking" } | { status: "invalid" } | { status: "valid"; token: string };

/** Reads `#token=…` once, strips it from the URL (history + address bar), then validates it. */
export function readAndStripFragmentToken(): string {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token") ?? "";
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return token;
}

export function ResetPasswordFlow() {
  const [state, setState] = useState<State>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;
    const token = readAndStripFragmentToken();
    // External system (URL fragment + server) → state: the intended use of an effect.
    const verify = token ? checkResetTokenAction(token) : Promise.resolve({ valid: false });
    verify
      .then((r) => !cancelled && setState(r.valid ? { status: "valid", token } : { status: "invalid" }))
      .catch(() => !cancelled && setState({ status: "invalid" }));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "checking") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking your reset link…
      </p>
    );
  }
  if (state.status === "invalid") {
    return (
      <div className="grid gap-4">
        <Alert variant="destructive" role="alert">
          <AlertDescription>This reset link is invalid or has expired. Please request a new one.</AlertDescription>
        </Alert>
        <Link href="/forgot-password" className="inline-flex min-h-11 items-center justify-center text-sm text-primary underline-offset-4 hover:underline">
          Request a new link
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">At least 10 characters. You will be signed out on all devices.</p>
      <ResetPasswordForm token={state.token} />
    </div>
  );
}
