import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@/lib/errors";

// Route-level unit test: the service (authorization, DB) is replaced so only the route's own
// behaviour is checked — status codes and headers. Prisma itself is not mocked; the service's DB
// behaviour is covered by tests/integration/settings-files.test.ts (pending a database).
// A plain stub (not vi.fn): Vitest's mock tracking reports a mocked async rejection as a test
// failure even when the route handles it.
let behaviour: () => Promise<unknown> = async () => {
  throw new Error("no behaviour set");
};
let calls = 0;
vi.mock("@/modules/files/files.service", () => ({
  readStoredFile: () => {
    calls++;
    return behaviour();
  },
}));
let signedIn = false; // whether the request carries a session cookie (and a valid session)
vi.mock("@/lib/auth/context", () => ({
  getAuthContext: async () => (signedIn ? { userId: "u1" } : null),
  clientIpHash: async () => "iphash-test",
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (signedIn ? { value: "session-token" } : undefined) }) }));

const { GET } = await import("@/app/api/v1/files/[id]/route");
const { resetLocalLimiterForTests, RULES } = await import("@/lib/rate-limit");
const { anonymousFileMisses } = await import("@/lib/http/public-file-guards");
const call = (id: string) => GET(new Request(`http://localhost/api/v1/files/${id}`), { params: Promise.resolve({ id }) });
const file = (over: Record<string, unknown>) => ({
  bytes: Buffer.from("%PDF-1.7"),
  mimeType: "application/pdf",
  originalName: "certificate.pdf",
  visibility: "PRIVATE",
  sha256: "a".repeat(64),
  publiclyReadable: false,
  ...over,
});

beforeEach(() => {
  calls = 0;
  signedIn = false;
  resetLocalLimiterForTests();
  anonymousFileMisses.clear();
});
const resolves = (value: unknown) => {
  behaviour = async () => value;
};

describe("GET /api/v1/files/:id", () => {
  it("never lets shared caches store a non-public file — even a legacy row marked PUBLIC", async () => {
    resolves(file({ visibility: "PUBLIC", publiclyReadable: false }));
    const res = await call("legacyfile0001");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("private generated PDFs: no-store, nosniff", async () => {
    resolves(file({}));
    const res = await call("pdffile000001");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("only anonymously readable files get a public cache header", async () => {
    resolves(file({ mimeType: "image/png", visibility: "PUBLIC", publiclyReadable: true }));
    expect((await call("logofile00001")).headers.get("cache-control")).toBe("public, max-age=86400, immutable");
  });
  it("forbidden and missing files are both 404 with no body detail", async () => {
    behaviour = async () => {
      throw new NotFoundError("File not found.");
    };
    const res = await call("pdffile000001");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/pdf|forbidden|owner/i);
  });
  it("malformed ids are rejected before the service is called", async () => {
    for (const id of ["../etc/passwd", "x", "a".repeat(65), "abc%2F..%2F"]) {
      expect((await call(id)).status).toBe(404);
    }
    expect(calls).toBe(0);
  });

  it("S-10: private PDFs download as a sandboxed attachment; private images stay inline", async () => {
    resolves(file({}));
    const pdf = await call("pdffile000002");
    expect(pdf.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(pdf.headers.get("content-security-policy")).toBe("sandbox");
    resolves(file({ mimeType: "image/jpeg", originalName: "photo.jpg" }));
    const img = await call("imgfile000001");
    expect(img.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(img.headers.get("cache-control")).toBe("private, no-store");
  });
  it("S-04: an anonymous 'not found' is remembered — repeated probes don't reach the service (database)", async () => {
    behaviour = async () => {
      throw new NotFoundError();
    };
    expect((await call("missingfile01")).status).toBe(404);
    expect((await call("missingfile01")).status).toBe(404);
    expect((await call("missingfile01")).status).toBe(404);
    expect(calls).toBe(1);
  });
  it("S-04: a signed-in caller is never refused because of the anonymous miss cache", async () => {
    behaviour = async () => {
      throw new NotFoundError();
    };
    await call("privatefile01"); // anonymous → cached miss
    signedIn = true;
    resolves(file({}));
    expect((await call("privatefile01")).status).toBe(200);
    expect(calls).toBe(2);
  });
  it("S-04: per-IP limit in process — over the limit → 429 before the service is called", async () => {
    resolves(file({ mimeType: "image/png", publiclyReadable: true, visibility: "PUBLIC" }));
    for (let i = 0; i < RULES.filesPerIp.limit; i++) expect((await call("logofile00001")).status).toBe(200);
    const before = calls;
    const res = await call("logofile00001");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(calls).toBe(before);
  });
  it("malformed ids are 404 without counting or calling the service", async () => {
    expect((await call("bad..id")).status).toBe(404);
    expect(calls).toBe(0);
  });
});
