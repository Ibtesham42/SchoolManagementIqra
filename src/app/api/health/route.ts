import { prisma } from "@/lib/db";
import { isAuthorizedCron } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

/**
 * GET /api/health            → liveness only (never touches the database).
 * GET /api/health?deep=1     → also checks the database; requires `Authorization: Bearer $CRON_SECRET`.
 *
 * Why: Neon Free suspends compute after 5 idle minutes and allows 100 CU-hours/month. A public
 * health check that queried the DB on every ping (e.g. an uptime monitor each minute) would keep
 * compute awake 24/7 (~180 CU-hours) and exhaust the free allowance. Point uptime monitors at the
 * liveness URL; use the deep check from trusted schedulers only.
 */
export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  if (!deep) return Response.json({ status: "ok" });
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return Response.json({ error: { code: "UNAUTHENTICATED", message: "Unauthorized." } }, { status: 401 });
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", database: "ok" });
  } catch {
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
