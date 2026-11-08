/** Host-cron alternative to POST /api/cron/cleanup: `npm run cleanup` (uses DATABASE_URL). */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { runCleanup } from "../src/lib/maintenance";

runCleanup()
  .then((r) => console.log("cleanup:", JSON.stringify(r)))
  .catch((e) => {
    console.error("cleanup failed:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
