import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Runtime client. Uses the POOLED Neon URL (DATABASE_URL) through the node-postgres
 * driver adapter, which works on any Postgres host (portable deployment, ADR-017).
 * Migrations use DIRECT_URL via prisma.config.ts.
 *
 * Created lazily on first use, so importing this module (e.g. during `next build`
 * or in pure unit tests) never requires database credentials.
 */
/**
 * KI-044 / owner decision D11 (2026-11-10): app-wide interactive-transaction limits. Prisma's defaults (wait 2 s
 * for a pooled connection, 5 s per transaction) failed under bursts against remote Neon. Safeguards that come
 * with these values: no file I/O, image processing, password hashing or PDF work inside transactions;
 * transactions stay short; contended approvals also set a ~5 s lock_timeout; timeouts surface as a friendly
 * "busy" message (lib/db-errors isTransactionBusy). Bursts beyond the pool (DB_POOL_MAX, default 5) still queue
 * and may get that message — correctness (unique IDs, capacity) never depends on these limits.
 */
export const TX_MAX_WAIT_MS = 10_000;
export const TX_TIMEOUT_MS = 15_000;

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set (see docs/ENVIRONMENT_VARIABLES.md)");
  const adapter = new PrismaPg({
    connectionString,
    // Small pool: Neon Free has limited connections; the Neon pooler multiplexes.
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    // Fail fast instead of hanging when the DB is unreachable. 10 s allows a Neon cold start.
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 10_000),
  });
  return new PrismaClient({
    adapter,
    transactionOptions: { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS },
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

type Client = ReturnType<typeof createClient>;
const globalForPrisma = globalThis as unknown as { prisma?: Client };

function getClient(): Client {
  if (!globalForPrisma.prisma) globalForPrisma.prisma = createClient();
  return globalForPrisma.prisma;
}

export const prisma: Client = new Proxy({} as Client, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export type Db = Client;
export type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
