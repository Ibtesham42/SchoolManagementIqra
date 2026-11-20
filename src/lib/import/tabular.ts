import { crc32, inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { PayloadTooLargeError, UnsupportedMediaTypeError, ValidationError } from "@/lib/errors";

/**
 * Reads a small uploaded table (CSV or XLSX) into rows of trimmed strings, in memory — the file is never stored.
 * First user: marks import (Phase 4C-M4, AC19). Defences, in order:
 * 1. size cap BEFORE parsing; the format comes from the bytes (zip signature / no NUL bytes), not only the name;
 * 2. XLSX zip-bomb guard: the archive is read strictly here (exact central directory, no extra headers, no duplicate
 *    names), every entry inflated with a hard output cap (`maxOutputLength`) and the total capped; encrypted, zip64
 *    and unknown compression methods are refused. exceljs then parses a fresh STORED zip rebuilt from those checked
 *    buffers — never the uploaded bytes — so the guard and the parser cannot disagree (review 4C-M4 H1);
 * 3. row / column / cell-length caps while reading; formulas give their cached result as text, never evaluated;
 * 4. cells are plain strings — callers validate every value with their own rules.
 */
export const TABLE_LIMITS = {
  maxBytes: 512 * 1024,
  maxRows: 500,
  maxCols: 30,
  maxCellChars: 200,
  // Review 4C-M4 M1: 500 × 30 cells of ≤ 200 characters is ~3 MB of XML; exceljs builds an object per cell.
  maxUnzippedBytes: 4 * 1024 * 1024,
  maxZipEntries: 200,
} as const;

export type Table = string[][];
export type TableFormat = "csv" | "xlsx";

const tooBig = () => new PayloadTooLargeError(`The file is larger than ${TABLE_LIMITS.maxBytes / 1024} KB. Use the downloaded template.`);
const unreadable = (what = "The file couldn't be read.") => new ValidationError(`${what} Save it as .xlsx or .csv (for example from the downloaded template) and try again.`, [{ path: "file", message: what }]);

/** XLSX when the bytes are a zip and the name says .xlsx; CSV when the name says .csv and the bytes are text. */
export function detectFormat(bytes: Uint8Array, fileName: string): TableFormat {
  const name = fileName.toLowerCase();
  const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (name.endsWith(".xlsx")) {
    if (!zip) throw unreadable("This isn't a valid .xlsx file.");
    return "xlsx";
  }
  if (name.endsWith(".csv")) {
    if (zip || bytes.includes(0)) throw unreadable("This isn't a plain-text .csv file.");
    return "csv";
  }
  throw new UnsupportedMediaTypeError("Upload an .xlsx or .csv file.");
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

type ZipLimits = { maxUnzippedBytes: number; maxZipEntries: number };
export type ZipEntry = { name: Uint8Array; data: Uint8Array };

/**
 * Strict zip reader (inflates into capped buffers, writes nothing): every entry inflated with a hard output cap, the
 * total capped, and the archive must be exactly what its end record says — no bytes before the archive, no extra or
 * missing central headers, no duplicate names (review 4C-M4 H1: jszip reads extra headers and shifted offsets that
 * a looser check would skip). Returns the entries, or a reason.
 */
export function readZipEntries(bytes: Uint8Array, limits: ZipLimits = TABLE_LIMITS): { entries: ZipEntry[] } | { problem: string } {
  const minEocd = 22;
  if (bytes.length < minEocd) return { problem: "too short" };
  // The end record must be the last thing in the file (no archive comment): exactly one place to look.
  const eocd = bytes.length - minEocd;
  if (u32(bytes, eocd) !== 0x06054b50) return { problem: "no central directory" };
  if (u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0 || u16(bytes, eocd + 8) !== u16(bytes, eocd + 10)) return { problem: "multi-disk" };
  const entries = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { problem: "zip64" };
  if (entries === 0 || entries > limits.maxZipEntries) return { problem: "entry count" };
  if (cdOffset + cdSize !== eocd) return { problem: "bad central directory" };
  const out: ZipEntry[] = [];
  const names = new Set<string>();
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || u32(bytes, p) !== 0x02014b50) return { problem: "bad entry" };
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressed = u32(bytes, p + 20);
    const declared = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    if (flags & 0x1) return { problem: "encrypted" };
    if (compressed === 0xffffffff || declared === 0xffffffff || local === 0xffffffff) return { problem: "zip64" };
    if (p + 46 + nameLen > eocd) return { problem: "bad entry" };
    const name = bytes.slice(p + 46, p + 46 + nameLen);
    const key = Buffer.from(name).toString("latin1");
    if (nameLen === 0 || names.has(key)) return { problem: "duplicate name" };
    names.add(key);
    if (local + 30 > cdOffset || u32(bytes, local) !== 0x04034b50) return { problem: "bad local header" };
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (start + compressed > cdOffset) return { problem: "truncated" };
    const raw = bytes.subarray(start, start + compressed);
    const budget = limits.maxUnzippedBytes - total;
    let data: Uint8Array;
    if (method === 0) {
      data = raw.slice();
    } else if (method === 8) {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, budget) }));
      } catch (e) {
        // Over the output cap → the zip-bomb case; anything else is corrupt data.
        return { problem: e instanceof RangeError || (e as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE" ? "too large unzipped" : "inflate" };
      }
    } else {
      return { problem: "method" };
    }
    total += data.length;
    if (total > limits.maxUnzippedBytes) return { problem: "too large unzipped" };
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // Exactly the declared headers: nothing after the last one (jszip would keep reading further headers).
  if (p !== eocd) return { problem: "extra central headers" };
  return { entries: out };
}

export function zipProblem(bytes: Uint8Array, limits: ZipLimits = TABLE_LIMITS): string | null {
  const r = readZipEntries(bytes, limits);
  return "problem" in r ? r.problem : null;
}

/** A fresh STORED zip of already-checked entries — the only bytes exceljs ever parses (guard and parser agree). */
export function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(e.name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(e.name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, e.name, e.data);
    central.push(cd, e.name);
    offset += 30 + e.name.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, eocd]));
}

function cap(rows: Table): Table {
  if (rows.length > TABLE_LIMITS.maxRows) throw new ValidationError(`The file has more than ${TABLE_LIMITS.maxRows} rows.`, [{ path: "file", message: "Too many rows." }]);
  return rows.map((r) => {
    if (r.length > TABLE_LIMITS.maxCols) throw new ValidationError(`The file has more than ${TABLE_LIMITS.maxCols} columns.`, [{ path: "file", message: "Too many columns." }]);
    return r.map((c) => c.normalize("NFC").trim().slice(0, TABLE_LIMITS.maxCellChars));
  });
}

const nonEmpty = (rows: Table) => rows.filter((r) => r.some((c) => c !== ""));

export function parseCsvTable(text: string): Table {
  const body = text.replace(/^﻿/, "");
  const res = Papa.parse<string[]>(body, { skipEmptyLines: "greedy", preview: TABLE_LIMITS.maxRows + 1, dynamicTyping: false });
  if (res.errors.some((e) => e.type === "Quotes")) throw unreadable("A quoted cell in the CSV isn't closed.");
  return cap(nonEmpty(res.data.map((r) => r.map((c) => String(c)))));
}

/** The text a person sees in a cell; formulas → their cached result (never evaluated), dates → YYYY-MM-DD. */
export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return cellText((v.result ?? null) as ExcelJS.CellValue);
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("error" in v) return "";
  }
  return "";
}

export async function parseXlsxTable(bytes: Uint8Array): Promise<Table> {
  const zip = readZipEntries(bytes);
  if ("problem" in zip) throw unreadable("The .xlsx file is damaged, encrypted or too large once unpacked.");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(storedZip(zip.entries)) as unknown as ArrayBuffer);
  } catch {
    throw unreadable("The .xlsx file couldn't be opened.");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw unreadable("The .xlsx file has no sheet.");
  if (ws.actualRowCount > TABLE_LIMITS.maxRows || ws.actualColumnCount > TABLE_LIMITS.maxCols) {
    throw new ValidationError(`The sheet is too large (at most ${TABLE_LIMITS.maxRows} rows and ${TABLE_LIMITS.maxCols} columns).`, [{ path: "file", message: "Too large." }]);
  }
  const rows: Table = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= Math.min(row.cellCount, TABLE_LIMITS.maxCols); c++) cells.push(cellText(row.getCell(c).value));
    rows.push(cells);
  });
  return cap(nonEmpty(rows));
}

/** Format detection → parse. Size is checked first. */
export async function readTable(bytes: Uint8Array, fileName: string): Promise<{ format: TableFormat; rows: Table }> {
  if (bytes.length === 0) throw new ValidationError("The file is empty.", [{ path: "file", message: "Choose a file." }]);
  if (bytes.length > TABLE_LIMITS.maxBytes) throw tooBig();
  const format = detectFormat(bytes, fileName);
  if (format === "csv") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unreadable("The CSV isn't UTF-8 text.");
    }
    return { format, rows: parseCsvTable(text) };
  }
  return { format, rows: await parseXlsxTable(bytes) };
}

/** Formula-safe XLSX for templates: every cell is written as a string, prefixed with ' when it could start a formula. */
export async function toXlsx(sheetName: string, header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): Promise<Uint8Array> {
  const safe = (v: string | number | null) => {
    if (v === null) return "";
    const s = String(v);
    return /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\u0000-\u001f]/.test(s) ? `'${s}` : s;
  };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  ws.addRow(header.map(safe));
  for (const r of rows) ws.addRow(r.map(safe));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c, i) => {
    c.width = i === 2 ? 28 : 14;
  });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
