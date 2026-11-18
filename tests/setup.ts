import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { INTEGRATION_FLAG } from "./test-scope";

// KI-043: only an explicit `npm run test:integration` run may load .env or see a database URL.
if (process.env[INTEGRATION_FLAG] === "1") {
  // Integration tests run ONLY against the dedicated test database (Neon "test" branch).
  // The development/production URLs from .env are never used by tests.
  config({ quiet: true });
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    delete process.env.DATABASE_URL;
  }
  delete process.env.DIRECT_URL; // the development direct URL is never needed by tests
} else {
  // Unit runs never load .env and can never reach a database — even if the shell sets a URL.
  for (const k of ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", INTEGRATION_FLAG]) delete process.env[k];
}
process.env.RATE_LIMIT_DRIVER = "postgres";

// Ephemeral keys generated per test run — never real secrets.
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.DATA_ENCRYPTION_KEY_VERSION = "1";
process.env.DATA_HMAC_KEY = randomBytes(32).toString("base64");
process.env.DOCUMENT_VERIFICATION_KEY = randomBytes(32).toString("base64");
process.env.DOCUMENT_VERIFICATION_KEY_VERSION = "1";
process.env.SESSION_SECRET = randomBytes(32).toString("base64");
