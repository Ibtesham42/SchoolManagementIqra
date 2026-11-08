import { isAuthorizedCron, runCleanup } from "@/lib/maintenance";

export const dynamic = "force-dynamic";

/** POST with `Authorization: Bearer $CRON_SECRET`. Returns only deletion counts. */
export async function POST(request: Request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return Response.json({ error: { code: "UNAUTHENTICATED", message: "Unauthorized." } }, { status: 401 });
  }
  try {
    const result = await runCleanup();
    console.info("[cron:cleanup]", JSON.stringify(result));
    return Response.json({ status: "ok", deleted: result });
  } catch {
    return Response.json({ error: { code: "INTERNAL", message: "Cleanup failed." } }, { status: 503 });
  }
}
