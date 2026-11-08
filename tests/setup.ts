import "dotenv/config";
import { randomBytes } from "node:crypto";

// Integration tests run ONLY against a dedicated test database (Neon "test" branch).
// The development/production URLs from .env are never used by tests.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  delete process.env.DATABASE_URL;
}
process.env.RATE_LIMIT_DRIVER = "postgres";

// Ephemeral keys generated per test run — never real secrets.
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.DATA_ENCRYPTION_KEY_VERSION = "1";
process.env.DATA_HMAC_KEY = randomBytes(32).toString("base64");
process.env.SESSION_SECRET = randomBytes(32).toString("base64");
