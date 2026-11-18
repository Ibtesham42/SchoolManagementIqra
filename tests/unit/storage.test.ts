import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectFileType } from "@/lib/storage/file-types";
import { sanitizeFileName, validateUpload, UPLOAD_RULES } from "@/lib/storage/upload-rules";
import { LocalDriver, MemoryDriver, assertValidKey, newStorageKey } from "@/lib/storage/driver";
import { createDownloadToken, verifyDownloadToken } from "@/lib/storage/download-token";
import { ValidationError } from "@/lib/errors";

// Smallest valid PNG (1×1), JPEG/PDF/WebP/ZIP headers padded to ≥ 12 bytes.
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj");
const zip = (parts: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from(`[Content_Types].xml${parts}`)]);
const HTML_AS_PNG = Buffer.from("<html><script>alert(1)</script></html>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe("content-based type detection", () => {
  it("recognises allowed formats by their bytes", () => {
    expect(detectFileType(PNG)).toBe("image/png");
    expect(detectFileType(JPEG)).toBe("image/jpeg");
    expect(detectFileType(WEBP)).toBe("image/webp");
    expect(detectFileType(PDF)).toBe("application/pdf");
    expect(detectFileType(zip("word/document.xml"))).toBe("docx");
    expect(detectFileType(zip("xl/workbook.xml"))).toBe("xlsx");
  });
  it("rejects HTML, SVG, plain ZIPs and tiny files regardless of name", () => {
    expect(detectFileType(HTML_AS_PNG)).toBeNull();
    expect(detectFileType(SVG)).toBeNull();
    expect(detectFileType(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]))).toBeNull();
    expect(detectFileType(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe("upload validation (school.logo)", () => {
  it("accepts PNG/JPEG and returns the detected MIME type, not the declared one", () => {
    const v = validateUpload(PNG, "logo.jpg", "school.logo");
    expect(v.mimeType).toBe("image/png");
    expect(v.extension).toBe("png");
  });
  it("rejects WebP for logos (PDF engine can't embed it), PDFs, HTML disguised as .png and SVG", () => {
    for (const [bytes, name] of [[WEBP, "logo.webp"], [PDF, "logo.pdf"], [HTML_AS_PNG, "logo.png"], [SVG, "logo.svg"]] as const) {
      expect(() => validateUpload(bytes, name, "school.logo")).toThrow(/isn't accepted/);
    }
  });
  it("enforces the size limit and rejects empty files", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(UPLOAD_RULES["school.logo"].maxBytes)]);
    expect(() => validateUpload(big, "logo.png", "school.logo")).toThrow(/limit is 800 KB/);
    expect(() => validateUpload(Buffer.alloc(0), "logo.png", "school.logo")).toThrow(ValidationError);
  });
  it("sanitizes display names (no paths, control characters or reserved symbols)", () => {
    expect(sanitizeFileName("C:\\Users\\x\\..\\evil<>|.png", "png")).toBe("evil.png");
    expect(sanitizeFileName("../../etc/passwd", "png")).toBe("passwd");
    expect(sanitizeFileName("\u0000\u0007", "png")).toBe("file.png");
    expect(sanitizeFileName("a".repeat(400), "png")).toHaveLength(200);
  });
});

describe("storage keys", () => {
  it("are random, dated, visibility-prefixed and never contain the original name", () => {
    const k1 = newStorageKey("PRIVATE", new Date(Date.UTC(2026, 10, 8)));
    const k2 = newStorageKey("PRIVATE", new Date(Date.UTC(2026, 10, 8)));
    expect(k1).toMatch(/^private\/2026\/11\/[A-Za-z0-9_-]{32}$/);
    expect(k1).not.toBe(k2);
    expect(newStorageKey("PUBLIC")).toMatch(/^public\//);
  });
  it("reject traversal and malformed keys", () => {
    for (const bad of ["../x", "private/2026/11/../../etc", "private/2026/11/short", "other/2026/11/" + "a".repeat(32), "private\\2026\\11\\" + "a".repeat(32)]) {
      expect(() => assertValidKey(bad)).toThrow();
    }
  });
});

describe("LocalDriver", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "erp-storage-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("requires an absolute root", () => {
    expect(() => new LocalDriver("relative/dir")).toThrow(/absolute/);
  });
  it("refuses a storage root that Next.js would serve directly (public/, .next/) or that contains them", () => {
    const app = resolve(tmpdir(), "erp-app");
    for (const bad of [join(app, "public"), join(app, "public", "uploads"), join(app, ".next", "x"), app, resolve(app, "..")]) {
      expect(() => new LocalDriver(bad, app)).toThrow(/outside the app's public\/ and \.next\/ folders/);
    }
    expect(() => new LocalDriver(join(app, "storage-private"), app)).not.toThrow(); // beside them is fine
    expect(() => new LocalDriver(resolve(tmpdir(), "erp-files"), app)).not.toThrow();
  });
  it("round-trips bytes atomically (no temp files left behind) and deletes", async () => {
    const d = new LocalDriver(root);
    const key = newStorageKey("PRIVATE");
    await d.put(key, PNG);
    expect(await d.exists(key)).toBe(true);
    expect(Buffer.compare(await d.get(key), PNG)).toBe(0);
    const dir = join(root, ...key.split("/").slice(0, -1));
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    await d.delete(key);
    expect(await d.exists(key)).toBe(false);
  });
  it("never writes outside the root", async () => {
    const d = new LocalDriver(root);
    expect(() => d.pathFor("../../outside")).toThrow();
    const key = newStorageKey("PUBLIC");
    expect(d.pathFor(key).startsWith(root)).toBe(true);
  });
  it("refuses to overwrite an existing key", async () => {
    const d = new LocalDriver(root);
    const key = newStorageKey("PUBLIC");
    await d.put(key, PNG);
    // keys are random per upload, so a collision means a bug — the second write must not clobber the first
    await expect(d.put(key, Buffer.from("other"))).rejects.toThrow(/already exists/);
    expect(Buffer.compare(await readFile(d.pathFor(key)), PNG)).toBe(0);
  });
});

describe("MemoryDriver", () => {
  it("validates keys like the real driver", async () => {
    const m = new MemoryDriver();
    await expect(m.put("../x", PNG)).rejects.toThrow();
    const key = newStorageKey("PUBLIC");
    await m.put(key, PNG);
    await expect(m.put(key, PNG)).rejects.toThrow(/already exists/);
  });
});

describe("download tokens", () => {
  const now = Date.UTC(2026, 10, 8, 10, 0, 0);
  it("verify only for the same file and user, before expiry", () => {
    const t = createDownloadToken("file1", "user1", now);
    expect(verifyDownloadToken(t, "file1", "user1", now + 60_000)).toBe(true);
    expect(verifyDownloadToken(t, "file2", "user1", now)).toBe(false);
    expect(verifyDownloadToken(t, "file1", "user2", now)).toBe(false);
    expect(verifyDownloadToken(t, "file1", "user1", now + 6 * 60_000)).toBe(false);
  });
  it("reject tampering and garbage", () => {
    const t = createDownloadToken("file1", "user1", now);
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ f: "file1", u: "admin", e: 9_999_999_999 })).toString("base64url");
    expect(verifyDownloadToken(`${forged}.${sig}`, "file1", "admin", now)).toBe(false);
    // Always change the first signature character (a fixed "x" was a no-op 1 time in 64).
    const flipped = (sig[0] === "x" ? "y" : "x") + sig.slice(1);
    expect(verifyDownloadToken(`${body}.${flipped}`, "file1", "user1", now)).toBe(false);
    expect(verifyDownloadToken("not-a-token", "file1", "user1", now)).toBe(false);
  });
});
