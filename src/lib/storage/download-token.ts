import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/crypto";

/**
 * Short-lived, user-bound download tokens for private files (e.g. a link opened in a new tab or a
 * future S3 presigned redirect). A token never replaces authorization: the download route still
 * requires a session, checks access, and the token's user must equal the session user.
 */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 5 * 60;

interface Payload {
  f: string; // file id
  u: string; // user id
  e: number; // expiry (unix seconds)
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET is not set");
  return s;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(`dl:${body}`).digest("base64url");
}

export function createDownloadToken(fileId: string, userId: string, nowMs = Date.now(), ttlSeconds = DOWNLOAD_TOKEN_TTL_SECONDS): string {
  const body = Buffer.from(JSON.stringify({ f: fileId, u: userId, e: Math.floor(nowMs / 1000) + ttlSeconds } satisfies Payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Returns true only for an untampered, unexpired token issued for exactly this file and user. */
export function verifyDownloadToken(token: string, fileId: string, userId: string, nowMs = Date.now()): boolean {
  if (typeof token !== "string" || token.length > 600) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(sig, sign(body))) return false;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    return p.f === fileId && p.u === userId && typeof p.e === "number" && p.e * 1000 > nowMs;
  } catch {
    return false;
  }
}
