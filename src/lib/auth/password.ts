import { hash, verify } from "@node-rs/argon2";

/** OWASP baseline for Argon2id: m=19 MiB, t=2, p=1 (docs/AUTHENTICATION_AND_RBAC.md). */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

// A small built-in deny list; extend with a larger list file if needed.
const COMMON = new Set([
  "password", "password1", "password123", "123456789", "1234567890", "qwerty123", "iloveyou",
  "admin12345", "welcome123", "school1234", "letmein123", "abc1234567", "qwertyuiop",
]);

export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string, username?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 128) return "Password must be at most 128 characters.";
  if (COMMON.has(password.toLowerCase())) return "This password is too common.";
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "Password must not contain the username.";
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** A real hash used to equalize timing when the username does not exist. */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("timing-equalizer-not-a-real-password");
  await verifyPassword(await dummyHash, password);
}
