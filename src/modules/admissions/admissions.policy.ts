import { ForbiddenError } from "@/lib/errors";
import type { Scope } from "@/lib/rbac/catalog";

/**
 * Record scope for admission applications (pure — unit tested). Every role that holds an admission
 * permission holds it at ALL scope (catalog, design §4.2): applications have no class-teacher or
 * parent relationship yet, so any narrower scope is refused rather than guessed. A future portal
 * ("my child's application") would add CHILDREN here explicitly.
 */
export function assertApplicationScope(scope: Scope): void {
  if (scope !== "ALL") throw new ForbiddenError();
}
