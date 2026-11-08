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
  return new PrismaClient({ adapter, log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });
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
