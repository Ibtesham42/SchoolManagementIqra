import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { usageToday } from "@/lib/usage";

/** Free-tier usage for the dashboard panel. Requires `usage.read`. */
export async function getUsageToday(ctx: AuthContext) {
  authorize(ctx, "usage.read");
  return usageToday();
}
