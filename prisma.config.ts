import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma CLI (migrate, studio) uses the DIRECT (non-pooled) Neon URL.
// The application runtime uses the pooled DATABASE_URL via the driver adapter (src/lib/db.ts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
