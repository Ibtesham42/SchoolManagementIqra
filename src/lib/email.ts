import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consume } from "@/lib/usage";

/**
 * Email delivery behind one function (ADR-021). Providers:
 *  - "log"  (default): development preview. Outside production the full message is written ONLY to
 *           tmp/outbox/*.json (git-ignored) so developers and tests can open links; the console shows
 *           just kind, masked recipient, subject and the file path — never bodies (reset links).
 *           In production nothing but kind, masked recipient and subject is logged.
 *  - "resend": Resend Free via its HTTPS API (no SDK). Each send first reserves free-tier quota
 *           (lib/usage); at the cap the send is refused instead of incurring cost.
 *  - "none": drop silently (in-app notifications still work).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Category for logs/metrics, e.g. "password_reset". */
  kind: string;
}

export type EmailResult = { delivered: boolean; provider: string };

export async function sendEmail(msg: EmailMessage): Promise<EmailResult> {
  const provider = process.env.EMAIL_PROVIDER ?? "log";
  if (provider === "none") return { delivered: false, provider };
  if (provider === "resend") return sendViaResend(msg);
  return logEmail(msg);
}

function logEmail(msg: EmailMessage): EmailResult {
  if (process.env.NODE_ENV === "production") {
    console.info(`[email:log] ${msg.kind} → ${maskEmail(msg.to)} "${msg.subject}" (body not logged in production)`);
    return { delivered: false, provider: "log" };
  }
  const dir = join(process.cwd(), "tmp", "outbox");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${msg.kind}.json`);
  writeFileSync(file, JSON.stringify({ ...msg, at: new Date().toISOString() }, null, 2), "utf8");
  console.info(`[email:log] ${msg.kind} → ${maskEmail(msg.to)} "${msg.subject}" — preview saved to ${file}`);
  return { delivered: true, provider: "log" };
}

async function sendViaResend(msg: EmailMessage): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM");
  await consume("email.sent"); // throws QuotaExceededError at the free-tier cap
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Email provider responded ${res.status}`);
  return { delivered: true, provider: "resend" };
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 1)}***@${domain}`;
}
