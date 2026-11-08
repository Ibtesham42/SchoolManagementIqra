import type { Tx } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

/** Field names whose values must never be written to the audit log. */
const SENSITIVE_KEYS = new Set([
  "passwordHash",
  "password",
  "tokenHash",
  "token",
  "temporaryPassword",
  "newPassword",
  "currentPassword",
  "confirmPassword",
  "secret",
  "aadhaar",
  "aadhaarEnc",
  "aadhaarHmac",
  "pan",
  "panEnc",
  "bankAccount",
  "bankAccountEnc",
  "medical",
]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.has(k) ? "[REDACTED]" : redact(v)]),
    );
  }
  return value;
}

export interface AuditActor {
  userId: string | null;
  label?: string;
  ipHash?: string;
  requestId?: string;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Write inside the same transaction as the change being recorded. */
export async function audit(tx: Tx, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: actor.userId,
      actorLabel: actor.label,
      ipHash: actor.ipHash,
      requestId: actor.requestId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before === undefined ? undefined : (redact(entry.before) as Prisma.InputJsonValue),
      after: entry.after === undefined ? undefined : (redact(entry.after) as Prisma.InputJsonValue),
    },
  });
}
