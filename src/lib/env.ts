import { z } from "zod";

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

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Print variable names only — never values.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\nSee docs/ENVIRONMENT_VARIABLES.md`);
  }
  const { NODE_ENV, APP_URL, EMAIL_PROVIDER, EMAIL_FROM, RESEND_API_KEY } = parsed.data;
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
