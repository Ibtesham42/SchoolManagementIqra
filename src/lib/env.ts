import { z } from "zod";
import { parseRotatedKeyName } from "@/lib/verification-code";

/**
 * Validated environment. Import `env` instead of reading `process.env` directly.
 * Optional providers default to "none" so the app never calls a paid/metered service
 * unless it is explicitly configured. See docs/ENVIRONMENT_VARIABLES.md.
 */
const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  APP_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  DATA_ENCRYPTION_KEY: base64Key,
  DATA_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
  DATA_HMAC_KEY: base64Key,
  // Document verification codes only (ADR-031). Older keys: DOCUMENT_VERIFICATION_KEY_V<n>.
  DOCUMENT_VERIFICATION_KEY: base64Key,
  DOCUMENT_VERIFICATION_KEY_VERSION: z.coerce.number().int().min(1).max(32767).default(1),

  PRIVATE_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  PRIVATE_STORAGE_LOCAL_DIR: z.string().optional(),
  PUBLIC_MEDIA_DRIVER: z.enum(["local", "cloudinary"]).default("local"),

  EMAIL_PROVIDER: z.enum(["log", "resend", "none"]).default("log"),
  EMAIL_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  CRON_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  AI_PROVIDER: z.enum(["none", "openai-compatible", "anthropic"]).default("none"),
  AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().nonnegative().default(0),

  RATE_LIMIT_DRIVER: z.enum(["memory", "postgres"]).default("postgres"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

/**
 * Each key has one job: reusing a key across features (or keeping a rotated-out verification key
 * equal to the current one) silently weakens separation. Names only in messages, never values.
 */
export function checkKeySeparation(
  env: Pick<Env, "DATA_ENCRYPTION_KEY" | "DATA_HMAC_KEY" | "DOCUMENT_VERIFICATION_KEY" | "DOCUMENT_VERIFICATION_KEY_VERSION">,
  raw: Record<string, string | undefined>,
): string[] {
  const problems: string[] = [];
  const named = [
    ["DATA_ENCRYPTION_KEY", env.DATA_ENCRYPTION_KEY],
    ["DATA_HMAC_KEY", env.DATA_HMAC_KEY],
    ["DOCUMENT_VERIFICATION_KEY", env.DOCUMENT_VERIFICATION_KEY],
  ] as const;
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      if (named[i][1] === named[j][1]) problems.push(`${named[i][0]} and ${named[j][0]} must be different keys`);
    }
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!name.startsWith("DOCUMENT_VERIFICATION_KEY_V") || name === "DOCUMENT_VERIFICATION_KEY_VERSION" || !value) continue;
    const version = parseRotatedKeyName(name);
    if (version === null) {
      problems.push(`${name}: not a valid rotated-key name (use DOCUMENT_VERIFICATION_KEY_V<1–32767>, no leading zeros)`);
      continue;
    }
    if (Buffer.from(value, "base64").length !== 32) problems.push(`${name}: must be 32 bytes, base64-encoded`);
    if (version === env.DOCUMENT_VERIFICATION_KEY_VERSION) problems.push(`${name}: version ${version} is the current version — use DOCUMENT_VERIFICATION_KEY for it`);
    if (value === env.DOCUMENT_VERIFICATION_KEY) problems.push(`${name} must differ from DOCUMENT_VERIFICATION_KEY`);
  }
  return problems;
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  // An empty line in .env (e.g. `CRON_SECRET=` copied from .env.example) means "not set": optional
  // variables fall back to their defaults and required ones are still reported as missing.
  const input = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // Print variable names only — never values.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\nSee docs/ENVIRONMENT_VARIABLES.md`);
  }
  const { NODE_ENV, APP_URL, EMAIL_PROVIDER, EMAIL_FROM, RESEND_API_KEY } = parsed.data;
  const keyProblems = checkKeySeparation(parsed.data, process.env);
  if (keyProblems.length) throw new Error(`Invalid environment configuration:\n${keyProblems.map((p) => `  - ${p}`).join("\n")}`);
  if (EMAIL_PROVIDER === "resend" && (!EMAIL_FROM || !RESEND_API_KEY)) {
    throw new Error("Invalid environment configuration:\n  - EMAIL_PROVIDER=resend requires EMAIL_FROM and RESEND_API_KEY");
  }
  const host = new URL(APP_URL).hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (NODE_ENV === "production" && !APP_URL.startsWith("https://") && !isLocal) {
    throw new Error("Invalid environment configuration:\n  - APP_URL: must use https:// in production (session cookies are Secure-only)");
  }
  cached = parsed.data;
  return cached;
}
