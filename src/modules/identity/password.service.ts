import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";
import { RULES, enforce } from "@/lib/rate-limit";
import { UnauthenticatedError, ValidationError } from "@/lib/errors";
import type { AuthContext } from "@/lib/rbac/authorize";

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(1).max(128),
    confirmPassword: z.string().min(1).max(128),
  })
  .strict();

/** Any signed-in user may change their own password; all other sessions are revoked. */
export async function changeOwnPassword(ctx: AuthContext, input: z.infer<typeof changePasswordSchema>) {
  if (!ctx) throw new UnauthenticatedError();
  if (input.newPassword !== input.confirmPassword) {
    throw new ValidationError("Passwords do not match.", [{ path: "confirmPassword", message: "Passwords do not match." }]);
  }
  const problem = passwordProblem(input.newPassword, ctx.username);
  if (problem) throw new ValidationError(problem, [{ path: "newPassword", message: problem }]);

  await enforce(RULES.loginPerUser, ctx.username);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new ValidationError("Current password is incorrect.", [{ path: "currentPassword", message: "Incorrect password." }]);
  }
  if (await verifyPassword(user.passwordHash, input.newPassword)) {
    throw new ValidationError("Choose a password different from the current one.", [
      { path: "newPassword", message: "Must differ from the current password." },
    ]);
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: ctx.userId },
      data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
    });
    await audit(tx, { userId: ctx.userId, ipHash: ctx.ipHash }, { action: "auth.password_changed", entityType: "User", entityId: ctx.userId });
  });
  await revokeAllSessions(ctx.userId, ctx.sessionId);
}
