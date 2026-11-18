/** JSON.stringify replacer that encodes BigInt (e.g. audit_log.id) as a string instead of throwing. */
export const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);
