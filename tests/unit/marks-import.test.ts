import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cellText, detectFormat, parseCsvTable, parseXlsxTable, readTable, TABLE_LIMITS, toXlsx, zipProblem } from "@/lib/import/tabular";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { mergeSaved, planMarksImport, readMarkCell, type ImportRosterRow } from "@/modules/academic/marks-import.rules";
import { saveMarksSchema } from "@/modules/academic/marks.schemas";
import { templateColumns } from "@/modules/academic/marks-import.service";

/** Phase 4C-M4 (AC19) — marks import: file reading and its defences, matching rules, template route gates. */

const MAX = { theory: 80, practical: 0, internal: 20 };
const roster: ImportRosterRow[] = [
  { enrollmentId: "e1", studentCode: "STU-1", rollNumber: 1, fullName: "Asha Demo", mark: null },
  { enrollmentId: "e2", studentCode: "STU-2", rollNumber: 2, fullName: "Bina Demo", mark: { status: "PRESENT", theory: "60", practical: null, internal: "15", version: 3 } },
  { enrollmentId: "e3", studentCode: "STU-3", rollNumber: 3, fullName: "Chetan Demo", mark: null },
];
const H = ["Student ID", "Roll No", "Name", "Theory", "Internal"];

describe("readMarkCell", () => {
  it("accepts whole and half marks in common spellings, AB and EX", () => {
    expect(readMarkCell("42")).toEqual({ kind: "mark", value: "42" });
    expect(readMarkCell("42.50")).toEqual({ kind: "mark", value: "42.5" });
    expect(readMarkCell("07.0")).toEqual({ kind: "mark", value: "7" });
    expect(readMarkCell(" ab ")).toEqual({ kind: "status", status: "ABSENT" });
    expect(readMarkCell("Ex.")).toEqual({ kind: "status", status: "EXEMPT" });
    expect(readMarkCell("")).toEqual({ kind: "blank" });
    for (const bad of ["42.25", "-3", "=1+1", "4 2", "12345", "1e3"]) expect(readMarkCell(bad).kind, bad).toBe("bad");
  });
});

describe("planMarksImport", () => {
  it("plans new and changed rows, skips unchanged ones and counts students left out", () => {
    const plan = planMarksImport(
      [H, ["STU-1", "1", "x", "70", "18"], ["stu-2", "2", "", "60", "15"]],
      roster,
      MAX,
      true,
    );
    expect(plan.fileProblem).toBeNull();
    expect(plan.counts).toMatchObject({ new: 1, same: 1, problems: 0, notInFile: 1 });
    expect(plan.entries).toEqual([{ enrollmentId: "e1", status: "PRESENT", theory: "70", practical: null, internal: "18", version: null }]);
    // The planned entries are exactly what saveMarks accepts.
    expect(saveMarksSchema.safeParse({ examSubjectId: "es", sectionId: "s", sheetVersion: null, reason: "", entries: plan.entries.map((e) => ({ ...e, theory: e.theory ?? "", practical: e.practical ?? "", internal: e.internal ?? "" })), source: "import" }).success).toBe(true);
  });
  it("a blank cell keeps the saved mark; AB replaces the saved marks", () => {
    const plan = planMarksImport([H, ["STU-2", "", "", "65", ""], ["STU-1", "", "", "AB", ""]], roster, MAX, true);
    expect(plan.entries).toEqual([
      { enrollmentId: "e2", status: "PRESENT", theory: "65", practical: null, internal: "15", version: 3 },
      { enrollmentId: "e1", status: "ABSENT", theory: null, practical: null, internal: null, version: null },
    ]);
    expect(mergeSaved({ status: "ABSENT", theory: null, practical: null, internal: null }, roster[1].mark)).toMatchObject({ status: "ABSENT", theory: null });
  });
  it("refuses the whole file on any row problem", () => {
    const plan = planMarksImport(
      [H, ["STU-9", "", "", "10", "1"], ["STU-1", "", "", "81", "1"], ["STU-3", "", "", "AB", "12"], ["STU-3", "", "", "1", "1"], ["", "", "", "1", "1"], ["STU-2", "7", "", "1", "1"]],
      roster,
      MAX,
      true,
    );
    const problems = plan.rows.map((r) => r.problem);
    expect(problems[0]).toMatch(/isn't on this marks sheet/);
    expect(problems[1]).toMatch(/more than the maximum 80/);
    expect(problems[2]).toMatch(/leave marks blank for AB/);
    expect(problems[3]).toMatch(/more than once/);
    expect(problems[4]).toMatch(/Student ID is missing/);
    expect(problems[5]).toMatch(/Roll No 7 doesn't match/);
    expect(plan.counts.problems).toBe(6);
    expect(plan.entries).toEqual([]);
    expect(planMarksImport([H, ["STU-1", "", "", "4x", ""]], roster, MAX, true).rows[0].problem).toMatch(/"4x" isn't a mark/);
  });
  it("needs the Student ID column and a column for each examined part; parts not examined must stay blank", () => {
    expect(planMarksImport([["Name", "Theory"], ["a", "1"]], roster, MAX, true).fileProblem).toMatch(/Student ID/);
    expect(planMarksImport([["Student ID", "Theory"], ["STU-1", "1"]], roster, MAX, true).fileProblem).toMatch(/Internal/);
    expect(planMarksImport([H], roster, MAX, true).fileProblem).toMatch(/no student rows/);
    const p = planMarksImport([[...H, "Practical"], ["STU-1", "", "", "1", "1", "5"]], roster, MAX, true);
    expect(p.rows[0].problem).toMatch(/Practical isn't examined/);
  });
  it("an approver's correction needs complete marks for every listed student", () => {
    const p = planMarksImport([H, ["STU-1", "", "", "50", ""]], roster, MAX, false);
    expect(p.rows[0].problem).toMatch(/Internal marks are missing/);
  });
  it("a Status column must agree with the marks", () => {
    const p = planMarksImport([[...H, "Status"], ["STU-1", "", "", "EX", "", "AB"], ["STU-3", "", "", "", "", "Z"]], roster, MAX, true);
    expect(p.rows[0].problem).toMatch(/disagree/);
    expect(p.rows[1].problem).toMatch(/P, AB or EX/);
  });
  it("template columns leave out parts that aren't examined", () => {
    expect(templateColumns(MAX)).toEqual(["Student ID", "Roll No", "Name", "Theory", "Internal"]);
  });
});

describe("tabular reading", () => {
  it("detects the format from name AND bytes", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]);
    expect(detectFormat(zip, "m.XLSX")).toBe("xlsx");
    expect(detectFormat(new TextEncoder().encode("a,b"), "m.csv")).toBe("csv");
    expect(() => detectFormat(new TextEncoder().encode("a,b"), "m.xlsx")).toThrow(/valid .xlsx/);
    expect(() => detectFormat(zip, "m.csv")).toThrow(/plain-text/);
    expect(() => detectFormat(zip, "m.xls")).toThrow(/\.xlsx or \.csv/);
  });
  it("reads CSV with a BOM, quotes and blank lines; caps rows", async () => {
    expect(parseCsvTable('﻿Student ID,Name\r\n"STU-1"," Asha, D "\r\n\r\n,\r\n')).toEqual([
      ["Student ID", "Name"],
      ["STU-1", "Asha, D"],
    ]);
    const many = ["a", ...Array.from({ length: TABLE_LIMITS.maxRows + 1 }, (_, i) => String(i))].join("\n");
    expect(() => parseCsvTable(many)).toThrow(/more than 500 rows/);
    await expect(readTable(new Uint8Array([0xff, 0xfe, 0x41]), "m.csv")).rejects.toThrow(/UTF-8/);
    await expect(readTable(new Uint8Array(TABLE_LIMITS.maxBytes + 1), "m.csv")).rejects.toThrow(/larger than/);
  });
  it("round-trips the XLSX template; formula-like text is neutralised; formulas give their cached result", async () => {
    const bytes = await toXlsx("6-A", ["Student ID", "Name"], [["STU-1", "=HYPERLINK(\"x\")"], ["STU-2", null]]);
    expect(zipProblem(bytes)).toBeNull();
    const rows = await parseXlsxTable(bytes);
    expect(rows).toEqual([["Student ID", "Name"], ["STU-1", "'=HYPERLINK(\"x\")"], ["STU-2", ""]]);
    expect(cellText({ formula: "1+1", result: 2 } as ExcelJS.CellValue)).toBe("2");
    expect(cellText({ richText: [{ text: "4" }, { text: "2" }] } as ExcelJS.CellValue)).toBe("42");
  });
  it("zip guard: refuses an entry that inflates past the budget, too many entries, encryption and garbage", async () => {
    const bytes = await toXlsx("s", ["a"], [["1"]]);
    expect(zipProblem(bytes, { maxUnzippedBytes: 500, maxZipEntries: 200 })).toBe("too large unzipped");
    expect(zipProblem(bytes, { maxUnzippedBytes: 1 << 24, maxZipEntries: 2 })).toBe("entry count");
    expect(zipProblem(new Uint8Array(100), TABLE_LIMITS)).toBe("no central directory");
    // A one-entry zip whose declared size is tiny but whose data inflates to 32 MB (lying header).
    const data = deflateRawSync(Buffer.alloc(32 * 1024 * 1024));
    const name = Buffer.from("x.xml");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(10, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(10, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 42);
    const cdOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length + name.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    const bomb = new Uint8Array(Buffer.concat([local, name, data, cd, name, eocd]));
    expect(zipProblem(bomb)).toBe("too large unzipped");
    const enc = Buffer.from(bomb);
    enc.writeUInt16LE(1, cdOffset + 8);
    expect(zipProblem(new Uint8Array(enc))).toBe("encrypted");
    await expect(parseXlsxTable(bomb)).rejects.toThrow(/damaged, encrypted or too large/);
  });
  it("review H1: the guard reads the archive exactly as declared — hidden headers, shifted offsets, duplicates, comments refused", async () => {
    const good = Buffer.from(await toXlsx("s", ["a"], [["1"]]));
    const eocd = good.length - 22;
    const count = good.readUInt16LE(eocd + 10);
    const cdOffset = good.readUInt32LE(eocd + 16);
    expect(zipProblem(new Uint8Array(good))).toBeNull();
    // End record claims one entry fewer: the last header is hidden from the count (jszip would still read it).
    const hidden = Buffer.from(good);
    hidden.writeUInt16LE(count - 1, eocd + 8);
    hidden.writeUInt16LE(count - 1, eocd + 10);
    expect(zipProblem(new Uint8Array(hidden))).toBe("extra central headers");
    // Bytes prepended before the archive (jszip shifts its offsets; we refuse).
    const shifted = Buffer.concat([Buffer.alloc(64), good]);
    expect(zipProblem(new Uint8Array(shifted))).not.toBeNull();
    // A trailing archive comment: the end record is no longer last.
    const comment = Buffer.concat([good, Buffer.from("hi")]);
    comment.writeUInt16LE(2, eocd + 20);
    expect(zipProblem(new Uint8Array(comment))).toBe("no central directory");
    // Duplicate names: rename the second entry to the first one's name (same length not guaranteed → compare first two of equal length).
    const nameAt = (p: number) => good.subarray(p + 46, p + 46 + good.readUInt16LE(p + 28));
    let p = cdOffset;
    const firstName = Buffer.from(nameAt(p));
    let dupDone = false;
    for (let i = 0; i < count && !dupDone; i++) {
      const len = good.readUInt16LE(p + 28);
      if (i > 0 && len === firstName.length) {
        const dup = Buffer.from(good);
        firstName.copy(dup, p + 46);
        expect(zipProblem(new Uint8Array(dup))).toBe("duplicate name");
        dupDone = true;
      }
      p += 46 + len + good.readUInt16LE(p + 30) + good.readUInt16LE(p + 32);
    }
    expect(dupDone).toBe(true);
    // The parser only ever sees the repacked archive, and it still reads correctly.
    expect(await parseXlsxTable(new Uint8Array(good))).toEqual([["a"], ["1"]]);
  });
});

// ───────────────────────────── Template route ─────────────────────────────

let ctx: AuthContext | null = null;
vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx, requireAuth: async () => ctx }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), enforce: async () => undefined }));
const template = vi.fn();
vi.mock("@/modules/academic/marks-import.service", async (orig) => {
  const real = await orig<typeof import("@/modules/academic/marks-import.service")>();
  return { ...real, marksImportTemplate: (c: AuthContext, r: unknown, f: "csv" | "xlsx") => (template.getMockImplementation() ? template(c, r, f) : real.marksImportTemplate(c, r as never, f)) };
});
const { POST } = await import("@/app/api/v1/academic/marks/template/route");

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows) };
}
const post = (origin: string | null, fields: Record<string, string> = { examSubjectId: "es1", sectionId: "s1", format: "csv" }) => {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = { host: "localhost", "content-type": "application/x-www-form-urlencoded" };
  if (origin) headers.origin = origin;
  return POST(new Request("http://localhost/api/v1/academic/marks/template", { method: "POST", headers, body }));
};

describe("marks template route", () => {
  beforeEach(() => {
    template.mockReset();
    ctx = null;
  });
  it("refuses cross-site posts and signed-out users", async () => {
    ctx = roleCtx("TEACHER");
    expect((await post("https://evil.example")).status).toBe(403);
    expect((await post(null)).status).toBe(403);
    ctx = null;
    expect((await post("http://localhost")).status).toBe(401);
  });
  it("every role without marks.enter / marks.approve is refused before any database access", async () => {
    const holders = new Set(ROLES.filter((r) => r.grants.map(normalizeGrant).some((g) => g.key === "marks.enter" || g.key === "marks.approve")).map((r) => r.key));
    expect(holders.has("TEACHER")).toBe(true);
    for (const role of ROLES) {
      if (holders.has(role.key)) continue;
      ctx = roleCtx(role.key);
      expect((await post("http://localhost")).status, role.key).toBe(403);
    }
  });
  it("bad input → 404-style invalid; success is a private attachment", async () => {
    ctx = roleCtx("TEACHER");
    expect((await post("http://localhost", { examSubjectId: "es1", sectionId: "s1", format: "pdf" })).status).toBe(404);
    template.mockImplementation(async () => ({ body: new TextEncoder().encode("a\r\n"), fileName: "marks-x.csv", contentType: "text/csv; charset=utf-8" }));
    const res = await post("http://localhost");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="marks-x.csv"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
