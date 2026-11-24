import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { endOfLocalDay, localDateTimeToUtc, utcToLocalDateTime } from "@/lib/zoned-time";
import { createNoticeSchema, updateNoticeSchema } from "@/modules/notices/notices.schemas";
import { FAMILY_AUDIENCES, liveWhere, mayWriteNotice, noticeState, publishMoment, STAFF_AUDIENCES } from "@/modules/notices/notices.policy";
import { familyNoticeWhere } from "@/modules/notices/notices.portal";
import { UPLOAD_RULES } from "@/lib/storage/upload-rules";
import { RULES } from "@/lib/rate-limit";

/** Phase 6C-M1 notices (P22) — offline: input rules, who may write where, life cycle, school time, static guards. */

const base = { academicSessionId: "sess1", title: "PTM on Saturday", body: "Parents are invited.\nRoom 4.", audience: "FAMILIES", scope: "SCHOOL", targetIds: [], publishAt: "", showUntil: "" };

describe("notice schemas", () => {
  it("accepts a whole-school family notice and normalises the text", () => {
    const r = createNoticeSchema.parse({ ...base, title: "  PTM   on Saturday ", body: "Line one  \r\nLine two\r\n" });
    expect(r.title).toBe("PTM on Saturday");
    expect(r.body).toBe("Line one\nLine two");
  });
  it("staff and 'all' notices are school-wide only; SCHOOL has no targets; CLASS / SECTION need some", () => {
    const err = (v: object) => {
      const r = createNoticeSchema.safeParse({ ...base, ...v });
      return r.success ? null : r.error.issues.map((i) => i.path.join("."));
    };
    expect(err({ audience: "STAFF", scope: "SECTION", targetIds: ["s1"] })).toContain("scope");
    expect(err({ audience: "ALL", scope: "CLASS", targetIds: ["c1"] })).toContain("scope");
    expect(err({ audience: "STAFF" })).toBeNull();
    expect(err({ targetIds: ["s1"] })).toContain("targetIds");
    expect(err({ scope: "SECTION" })).toContain("targetIds");
    expect(err({ scope: "SECTION", targetIds: ["s1", "s1"] })).toContain("targetIds");
    expect(err({ scope: "CLASS", targetIds: Array.from({ length: 51 }, (_, i) => `c${i}`) })).toContain("targetIds");
    expect(err({ scope: "SECTION", targetIds: ["s1", "s2"] })).toBeNull();
  });
  it("limits: title 150, body 4,000, no control characters, strict objects, valid times", () => {
    expect(createNoticeSchema.safeParse({ ...base, title: "x".repeat(151) }).success).toBe(false);
    expect(createNoticeSchema.safeParse({ ...base, body: "x".repeat(4001) }).success).toBe(false);
    expect(createNoticeSchema.safeParse({ ...base, body: "a\u0000b" }).success).toBe(false);
    expect(createNoticeSchema.safeParse({ ...base, title: "a​b" }).success).toBe(false);
    expect(createNoticeSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(createNoticeSchema.safeParse({ ...base, publishAt: "2026-11-25 07:30" }).success).toBe(false);
    expect(createNoticeSchema.safeParse({ ...base, publishAt: "2026-11-25T07:30", showUntil: "2026-11-30" }).success).toBe(true);
    expect(createNoticeSchema.safeParse({ ...base, audience: "PARENTS" }).success).toBe(false);
    const { academicSessionId: _session, ...edit } = base;
    expect(_session).toBe("sess1");
    expect(updateNoticeSchema.safeParse({ ...edit, id: "n1", version: "2" }).success).toBe(true);
  });
});

describe("who may write a notice (mayWriteNotice)", () => {
  const sec = (classTeacherId: string | null, sessionClosed = false) => ({ classTeacherId, sessionClosed });
  it("ALL: anything", () => {
    expect(mayWriteNotice("ALL", "u1", { createdById: "u1", audience: "STAFF", scope: "SCHOOL", sections: [] })).toBe(true);
    expect(mayWriteNotice("ALL", "u1", { createdById: "u1", audience: "FAMILIES", scope: "SECTION", sections: [sec("other", true)] })).toBe(true);
  });
  it("ASSIGNED: families of own sections in open sessions only", () => {
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "FAMILIES", scope: "SECTION", sections: [sec("u1")] })).toBe(true);
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "FAMILIES", scope: "SECTION", sections: [sec("u1"), sec("u1")] })).toBe(true);
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "FAMILIES", scope: "SECTION", sections: [sec("u1"), sec("u2")] })).toBe(false);
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "FAMILIES", scope: "SECTION", sections: [sec(null)] })).toBe(false);
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "FAMILIES", scope: "SECTION", sections: [sec("u1", true)] })).toBe(false);
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "FAMILIES", scope: "SECTION", sections: [] })).toBe(false);
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "FAMILIES", scope: "SCHOOL", sections: [] })).toBe(false);
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "FAMILIES", scope: "CLASS", sections: [] })).toBe(false);
    expect(mayWriteNotice("ASSIGNED", "u1", { createdById: "u1", audience: "ALL", scope: "SECTION", sections: [sec("u1")] })).toBe(false);
  });
  it("ASSIGNED: never someone else's notice to the same section (review 6C-M1 H1)", () => {
    const own = { audience: "FAMILIES" as const, scope: "SECTION" as const, sections: [sec("u1")] };
    expect(mayWriteNotice("ASSIGNED", "u1", { ...own, createdById: "principal" })).toBe(false);
    expect(mayWriteNotice("ASSIGNED", "u1", { ...own, createdById: null })).toBe(false); // author's account removed
    expect(mayWriteNotice("ALL", "u1", { ...own, createdById: "teacher" })).toBe(true);
  });
  it("no scope: nothing", () => {
    expect(mayWriteNotice(null, "u1", { createdById: "u1", audience: "FAMILIES", scope: "SCHOOL", sections: [] })).toBe(false);
  });
  it("audiences: staff never read family-only notices; families never read staff-only ones", () => {
    expect(STAFF_AUDIENCES).not.toContain("FAMILIES");
    expect(FAMILY_AUDIENCES).not.toContain("STAFF");
  });
});

describe("life cycle", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const at = (iso: string) => new Date(iso);
  it("states", () => {
    expect(noticeState({ status: "DRAFT", publishAt: null, expiresAt: null, sessionEnd: "2027-03-31" }, now, "2026-11-24")).toBe("DRAFT");
    expect(noticeState({ status: "PUBLISHED", publishAt: at("2026-11-25T00:00:00Z"), expiresAt: null, sessionEnd: "2027-03-31" }, now, "2026-11-24")).toBe("SCHEDULED");
    expect(noticeState({ status: "PUBLISHED", publishAt: at("2026-11-20T00:00:00Z"), expiresAt: null, sessionEnd: "2027-03-31" }, now, "2026-11-24")).toBe("LIVE");
    expect(noticeState({ status: "PUBLISHED", publishAt: at("2026-11-20T00:00:00Z"), expiresAt: now, sessionEnd: "2027-03-31" }, now, "2026-11-24")).toBe("EXPIRED");
    // Owner decision 2026-11-24 (review I1): without "show until" a notice ends with its session; "show until" wins.
    expect(noticeState({ status: "PUBLISHED", publishAt: at("2026-03-01T00:00:00Z"), expiresAt: null, sessionEnd: "2026-03-31" }, now, "2026-11-24")).toBe("EXPIRED");
    expect(noticeState({ status: "PUBLISHED", publishAt: at("2026-03-01T00:00:00Z"), expiresAt: null, sessionEnd: "2026-11-24" }, now, "2026-11-24")).toBe("LIVE"); // the last day counts
    expect(noticeState({ status: "PUBLISHED", publishAt: at("2026-03-01T00:00:00Z"), expiresAt: at("2026-12-31T00:00:00Z"), sessionEnd: "2026-03-31" }, now, "2026-11-24")).toBe("LIVE");
    expect(noticeState({ status: "WITHDRAWN", publishAt: at("2026-11-20T00:00:00Z"), expiresAt: null, sessionEnd: "2027-03-31" }, now, "2026-11-24")).toBe("WITHDRAWN");
  });
  it("publishing: past or no planned time = now; a future one is kept; expiry must come after", () => {
    expect(publishMoment(null, null, now)).toEqual({ publishAt: now });
    expect(publishMoment(at("2026-11-01T00:00:00Z"), null, now)).toEqual({ publishAt: now });
    expect(publishMoment(at("2026-11-26T02:00:00Z"), null, now)).toEqual({ publishAt: at("2026-11-26T02:00:00Z") });
    expect(publishMoment(null, at("2026-11-24T09:00:00Z"), now)).toHaveProperty("error");
    expect(publishMoment(at("2026-11-26T02:00:00Z"), at("2026-11-26T02:00:00Z"), now)).toHaveProperty("error");
    expect(publishMoment(null, at("2026-11-25T00:00:00Z"), now)).toEqual({ publishAt: now });
  });
  it("live filter: published, started, not expired (show until, or else the session's last day)", () => {
    expect(liveWhere(now, "2026-11-24")).toEqual({
      status: "PUBLISHED",
      publishAt: { lte: now },
      OR: [{ expiresAt: { gt: now } }, { expiresAt: null, academicSession: { endDate: { gte: new Date("2026-11-24T00:00:00.000Z") } } }],
    });
  });
});

describe("family audience filter", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  it("no child in an audience → nothing at all (not even whole-school notices)", () => {
    expect(familyNoticeWhere([], now, "2026-11-24")).toBeNull();
  });
  it("whole school, or each child's own class / section in that child's session; never staff-only", () => {
    const w = familyNoticeWhere(
      [
        { studentId: "k1", academicSessionId: "s26", classId: "c6", sectionId: "c6a" },
        { studentId: "k2", academicSessionId: "s26", classId: "c9", sectionId: "c9b" },
      ],
      now,
      "2026-11-24",
    )!;
    expect(w.audience).toEqual({ in: ["FAMILIES", "ALL"] });
    expect(w.status).toBe("PUBLISHED");
    expect(w.AND[0].OR).toEqual([
      { scope: "SCHOOL" },
      { scope: "CLASS", academicSessionId: "s26", targets: { some: { classId: "c6" } } },
      { scope: "CLASS", academicSessionId: "s26", targets: { some: { classId: "c9" } } },
      { scope: "SECTION", academicSessionId: "s26", targets: { some: { sectionId: "c6a" } } },
      { scope: "SECTION", academicSessionId: "s26", targets: { some: { sectionId: "c9b" } } },
    ]);
  });
});

describe("school-local times", () => {
  it("Asia/Kolkata (UTC+05:30) both ways", () => {
    expect(localDateTimeToUtc("2026-11-25T07:30", "Asia/Kolkata")!.toISOString()).toBe("2026-11-25T02:00:00.000Z");
    expect(utcToLocalDateTime(new Date("2026-11-25T02:00:00Z"), "Asia/Kolkata")).toBe("2026-11-25T07:30");
    expect(localDateTimeToUtc("2026-11-25T00:15", "Asia/Kolkata")!.toISOString()).toBe("2026-11-24T18:45:00.000Z");
  });
  it("a zone with DST (Europe/London) and UTC", () => {
    expect(localDateTimeToUtc("2026-07-01T09:00", "Europe/London")!.toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(localDateTimeToUtc("2026-12-01T09:00", "Europe/London")!.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(localDateTimeToUtc("2026-12-01T09:00", "UTC")!.toISOString()).toBe("2026-12-01T09:00:00.000Z");
  });
  it("rejects impossible values", () => {
    for (const v of ["2026-02-30T10:00", "2026-11-25T24:00", "2026-11-25T10:60", "2026-11-25", "x"]) expect(localDateTimeToUtc(v, "Asia/Kolkata"), v).toBeNull();
    expect(endOfLocalDay("2026-02-30", "Asia/Kolkata")).toBeNull();
  });
  it("'show until' a day = hidden from the next school midnight", () => {
    expect(endOfLocalDay("2026-11-30", "Asia/Kolkata")!.toISOString()).toBe("2026-11-30T18:30:00.000Z");
    expect(endOfLocalDay("2026-12-31", "Asia/Kolkata")!.toISOString()).toBe("2026-12-31T18:30:00.000Z");
  });
});

describe("configuration", () => {
  it("attachment rule: private, notice.manage uploads, notice.read reads (staff and portal), owner Notice", () => {
    expect(UPLOAD_RULES["notice.attachment"]).toMatchObject({ visibility: "PRIVATE", uploadPermission: "notice.manage", readPermission: "notice.read", portalReadPermission: "notice.read", ownerType: "Notice" });
  });
  it("compose rate limit: 30 per hour per user (plan §2.5)", () => {
    expect(RULES.noticeCompose).toEqual({ name: "notice-compose", limit: 30, windowSeconds: 3600 });
  });
});

describe("static guards", () => {
  const ROOT = join(__dirname, "..", "..");
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  it("audit rows never carry the title or the text", () => {
    const src = read("src", "modules", "notices", "notices.service.ts");
    for (const m of src.matchAll(/await audit\(tx, actorOf\(ctx\), \{([\s\S]*?)\}\);/g)) expect(m[1]).not.toMatch(/title|body/);
    expect([...src.matchAll(/await audit\(/g)].length).toBe(7); // create, update, delete, publish, withdraw, attach, remove attachment
  });
  it("family reads show no author, targets or read counts; every portal export refuses staff before the settings read", () => {
    const src = read("src", "modules", "notices", "notices.portal.ts");
    expect(src).not.toMatch(/createdBy|publishedBy|withdrawnBy|_count|targets: \{ select/);
    for (const body of src.split(/\nexport async function /).slice(1)) {
      const gate = body.indexOf("gate(ctx);");
      expect(gate, body.slice(0, 40)).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(body.indexOf("portalWindow()"));
    }
  });
  it("staff screens use the staff service, portal screens the portal reads", () => {
    for (const f of walk(join(ROOT, "src", "app", "erp", "notices"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/notices\.portal/);
    for (const f of walk(join(ROOT, "src", "app", "portal", "notices"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/notices\.service/);
  });
  it("notice pages record a receipt only when opened from this site (review 6C-M1 L2)", () => {
    expect(read("src", "app", "erp", "notices", "[id]", "page.tsx")).toMatch(/openStaffNotice\(ctx, id, \{ recordRead: await openedHere\(\) \}\)/);
    expect(read("src", "app", "portal", "notices", "[id]", "page.tsx")).toMatch(/openPortalNotice\(ctx, id, undefined, \{ recordRead: await openedHere\(\) \}\)/);
  });
  it("links that open a notice don't prefetch (opening records a read receipt)", () => {
    expect(read("src", "app", "erp", "notices", "page.tsx")).toMatch(/<Link prefetch=\{false\} href=\{`\/erp\/notices\/\$\{/);
    expect(read("src", "app", "portal", "notices", "page.tsx")).toMatch(/<Link prefetch=\{false\} href=\{`\/portal\/notices\/\$\{/);
  });
});
