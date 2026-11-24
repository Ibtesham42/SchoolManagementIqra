import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RETENTION } from "@/lib/maintenance";

/** Phase 6C-M2 — in-app notifications, offline: after-commit wiring, no sensitive text, keys, links, retention. */
const ROOT = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").split(String.fromCharCode(13)).join("");

const WIRED: [string, string][] = [
  ["src/modules/academic/results.service.ts", "publishResults"],
  ["src/modules/students/student-attendance.service.ts", "markStudentDay"],
  ["src/modules/fees/collection.service.ts", "collectPayment"],
  ["src/modules/fees/receipts.service.ts", "cancelReceipt"],
  ["src/modules/notices/notices.service.ts", "publishNotice"],
];

describe("notifications are enqueued AFTER the transaction (a rolled-back write sends nothing)", () => {
  for (const [file, fn] of WIRED) {
    it(`${fn}: afterCommit follows the transaction's catch block`, () => {
      const src = read(...file.split("/"));
      const start = src.indexOf(`export async function ${fn}(`);
      expect(start).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport async function ", start + 1);
      const body = src.slice(start, next < 0 ? undefined : next);
      const tx = body.indexOf("prisma.$transaction(");
      const caught = body.indexOf("} catch (e) {", tx);
      const after = body.indexOf("await afterCommit(");
      expect(tx).toBeGreaterThan(-1);
      expect(after, "afterCommit must come after the try / catch around the transaction").toBeGreaterThan(caught);
      expect(caught).toBeGreaterThan(tx);
    });
  }
  it("nothing calls deliver / afterCommit with a transaction client", () => {
    for (const [file] of WIRED) expect(read(...file.split("/"))).not.toMatch(/afterCommit\([^)]*\btx\b/);
  });
});

describe("notification text carries no sensitive data (plan §11)", () => {
  const builders = [
    ["src/modules/academic/results.service.ts", "async function resultNotifications", "\n}\n"],
    ["src/modules/students/student-attendance.service.ts", "async function absenceNotifications", "\n}\n"],
    ["src/modules/fees/fees.notify.ts", "export async function receiptNotifications", "\n}\n"],
    ["src/modules/notices/notices.service.ts", "async function noticeNotifications", "\n}\n"],
  ] as const;
  for (const [file, head, end] of builders) {
    it(`${head.split(" ").pop()}: names and what happened only`, () => {
      const src = read(...file.split("/"));
      const i = src.indexOf(head);
      const body = src.slice(i, src.indexOf(end, i));
      expect(body).not.toMatch(/\b(amount|receiptNo|transactionRef|reason|cancelReason|percent|grade|marks|obtained|fullName|phone|email)\b/);
      for (const m of body.matchAll(/link: `([^`]+)`/g)) expect(m[1].startsWith("/portal/")).toBe(true);
      expect(body).toMatch(/dedupeKey: `/);
    });
  }
  it("receipt notifications go to parents only; result notifications include student accounts", () => {
    expect(read("src", "modules", "fees", "fees.notify.ts")).toMatch(/familyRecipientsOf\(prisma, \[p\.studentId\], \{ students: false \}\)/);
    expect(read("src", "modules", "academic", "results.service.ts")).toMatch(/\{ students: true \}/);
  });
});

describe("dedupe keys, custody clearing, links, retention", () => {
  const svc = read("src", "modules", "notifications", "notifications.service.ts");
  it("every per-student key prefix is cleared on a custody block", () => {
    const prefixes = svc.match(/\["absence", "result", "receipt", "receipt-cancel"\]/);
    expect(prefixes).not.toBeNull();
    expect(read("src", "modules", "students", "student-attendance.service.ts")).toMatch(/dedupeKey: `absence:\$\{r\.studentId\}:/);
    expect(read("src", "modules", "academic", "results.service.ts")).toMatch(/dedupeKey: `result:\$\{r\.studentId\}:/);
    expect(read("src", "modules", "fees", "fees.notify.ts")).toMatch(/\$\{kind === "issued" \? "receipt" : "receipt-cancel"\}:\$\{r\.studentId\}:/);
    expect(read("src", "modules", "students", "family-accounts.service.ts")).toMatch(/forgetStudentNotifications\(await guardianAccountIds\(prisma, input\.guardianId\), input\.studentId\)/);
  });
  it("only /portal/ paths are stored or followed; the inbox opens by POST (server action), never by GET", () => {
    expect(svc).toMatch(/const LINK = \/\^\\\/portal\\\//);
    expect(read("src", "modules", "notifications", "notifications.portal.ts")).toMatch(/isPortalLink\(n\.link\) \? n\.link : "\/portal\/inbox"/);
    const page = read("src", "app", "portal", "inbox", "page.tsx");
    expect(page).toMatch(/<form action=\{openNotificationAction\}>/);
    expect(page).not.toMatch(/href=\{n\./);
  });
  it("inbox reads are the account's own", () => {
    for (const fn of ["markAllMyNotificationsRead", "markMyNotificationReadByKey"]) {
      const i = svc.indexOf(`export async function ${fn}(`);
      const body = svc.slice(i, svc.indexOf("\n}\n", i));
      expect(body, fn).toMatch(/userId: ctx\.userId/);
    }
    const portal = read("src", "modules", "notifications", "notifications.portal.ts");
    for (const fn of ["listPortalNotifications", "countPortalUnread", "openPortalNotification"]) {
      const i = portal.indexOf(`export async function ${fn}(`);
      expect(i, fn).toBeGreaterThan(-1);
      const body = portal.slice(i, portal.indexOf("\n}\n", i));
      expect(body, fn).toMatch(/userId: ctx\.userId/);
      expect(body, fn).toMatch(/visibleIds\(ctx, w, visible, /); // review 6C-M2: filtered at read time
      expect(body.indexOf("gate(ctx);"), fn).toBeLessThan(body.indexOf("portalWindow()"));
    }
  });
  it("notificationTarget: per-student kinds map to the page's capability; notices to their id; anything else hides", async () => {
    const { notificationTarget } = await import("@/modules/notifications/notifications.service");
    expect(notificationTarget("absence:s1:2026-11-24")).toEqual({ kind: "student", studentId: "s1", capability: "attendance" });
    expect(notificationTarget("result:s1:e1")).toEqual({ kind: "student", studentId: "s1", capability: "results" });
    expect(notificationTarget("receipt:s1:p1")).toEqual({ kind: "student", studentId: "s1", capability: "fees" });
    expect(notificationTarget("receipt-cancel:s1:p1")).toEqual({ kind: "student", studentId: "s1", capability: "fees" });
    expect(notificationTarget("notice:n1")).toEqual({ kind: "notice", noticeId: "n1" });
    for (const k of [null, "", "notice:", "absence:", "absence::x", "toString:s1:x", "__proto__:s1:x", "other:s1:x", "notice:n1:extra"]) expect(notificationTarget(k), String(k)).toBeNull();
  });
  it("withdrawing a notice removes its notifications after commit (review M3)", () => {
    const src = read("src", "modules", "notices", "notices.service.ts");
    const i = src.indexOf("export async function withdrawNotice(");
    const body = src.slice(i, src.indexOf("\n}\n", i));
    expect(body.indexOf("await forgetNoticeNotifications(input.id)")).toBeGreaterThan(body.indexOf("} catch (e) {"));
  });
  it("90-day retention in the cleanup job; bounded batches", () => {
    expect(RETENTION.notificationDays).toBe(90);
    expect(read("src", "lib", "maintenance.ts")).toMatch(/prisma\.notification\.deleteMany\(\{ where: \{ createdAt: \{ lt:/);
    expect(svc).toMatch(/const BATCH = 500;/);
    expect(svc).toMatch(/skipDuplicates: true/);
  });
  it("the header count is rendered, never polled", () => {
    const layout = read("src", "app", "portal", "layout.tsx");
    expect(layout).toMatch(/countPortalUnread\(ctx\)/);
    expect(layout).not.toMatch(/setInterval|refresh\(\)|useEffect/);
  });
});
