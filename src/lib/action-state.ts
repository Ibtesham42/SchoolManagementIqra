import { z } from "zod";
import { AppError } from "@/lib/errors";

/** Uniform result for server actions used with useActionState. */
export interface ActionState {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** One-time values to show the user (e.g. a temporary password). Never persisted. */
  secret?: string;
}

export const initialState: ActionState = {};

export function fromZod(error: z.ZodError): ActionState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    fieldErrors[key] ??= issue.message;
  }
  return { error: "Please correct the highlighted fields.", fieldErrors };
}

/**
 * Maps thrown errors to a safe ActionState. Known AppErrors show their (user-safe) message;
 * anything else is logged by name only and shown generically. Framework control-flow errors
 * (redirect/notFound) must be re-thrown by callers before reaching here — see rethrowIfNavigation.
 */
export function fromError(e: unknown): ActionState {
  if (e instanceof AppError) {
    return {
      error: e.message,
      fieldErrors: e.details ? Object.fromEntries(e.details.map((d) => [d.path, d.message])) : undefined,
    };
  }
  console.error("action failed", e instanceof Error ? e.name : "unknown");
  return { error: "Something went wrong. Please try again." };
}

/** Next.js redirect()/notFound() throw special errors that must propagate. */
export function rethrowIfNavigation(e: unknown): void {
  if (e && typeof e === "object" && "digest" in e && typeof (e as { digest: unknown }).digest === "string") {
    const digest = (e as { digest: string }).digest;
    if (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK")) throw e;
  }
}

export function formString(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
}
