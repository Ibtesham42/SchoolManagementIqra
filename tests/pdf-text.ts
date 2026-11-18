import { inflateSync } from "node:zlib";

/**
 * Minimal PDF text-position reader for tests (G7 B3/B4). Interprets the page content streams that
 * react-pdf writes — `q`/`Q`, `cm`, `Tm`, `Tf`, `TJ`/`Tj` — and returns every text run with its
 * position in PDF page space (points, origin bottom-left). Not a general PDF parser: it assumes one
 * FlateDecode content stream per page (react-pdf's output) and single-byte (WinAnsi) font encoding.
 */
export interface TextRun {
  page: number; // 1-based
  x: number;
  y: number; // baseline, points from the bottom edge
  fontSize: number;
  text: string;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** m1 applied first, then m2 (PDF row-vector convention). */
const multiply = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[1] * m2[2],
  m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2],
  m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
  m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];

/** WinAnsi bytes 0x80–0x9F that differ from Latin-1; everything else maps byte → code point. */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž",
  0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};
const decodeByte = (b: number) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b);

/** True when every character can be drawn by the built-in PDF fonts (Helvetica, WinAnsiEncoding). */
export const WIN_ANSI_CHARS = new Set([...Array.from({ length: 256 }, (_, b) => decodeByte(b))]);
export const nonWinAnsiChars = (text: string) => [...new Set([...text].filter((c) => !WIN_ANSI_CHARS.has(c) && c !== "\n" && c !== "\r" && c !== "\t"))];

function decodeStrings(operand: string): string {
  let out = "";
  for (const m of operand.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
    if (m[1] !== undefined) {
      const hex = m[1].replace(/\s/g, "");
      for (let i = 0; i + 1 < hex.length; i += 2) out += decodeByte(parseInt(hex.slice(i, i + 2), 16));
    } else {
      out += m[2].replace(/\\([nrtbf()\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[c] ?? c);
    }
  }
  return out;
}

function pageContentStreams(pdf: Buffer): string[] {
  const raw = pdf.toString("latin1");
  const streams: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      continue; // images and other binary streams
    }
    if (/\bBT\b/.test(content)) streams.push(content);
  }
  return streams;
}

export function extractTextRuns(pdf: Buffer): TextRun[] {
  const runs: TextRun[] = [];
  pageContentStreams(pdf).forEach((content, index) => {
    const tokens = content.match(/\[(?:[^\]\\]|\\.)*\]|<[0-9a-fA-F\s]*>|\((?:\\.|[^\\)])*\)|\/[^\s/[\]<>()]+|[^\s[\]<>()/]+/g) ?? [];
    let ctm: Matrix = IDENTITY;
    let tm: Matrix = IDENTITY;
    let fontSize = 0;
    const stack: Matrix[] = [];
    const operands: string[] = [];
    for (const t of tokens) {
      if (/^[A-Za-z'"*]+$/.test(t) && !/^(true|false|null)$/.test(t)) {
        const nums = operands.map(Number);
        switch (t) {
          case "q": stack.push(ctm); break;
          case "Q": ctm = stack.pop() ?? IDENTITY; break;
          case "cm": ctm = multiply(nums.slice(-6) as Matrix, ctm); break;
          case "BT": tm = IDENTITY; break;
          case "Tm": tm = nums.slice(-6) as Matrix; break;
          case "Td": tm = multiply([1, 0, 0, 1, nums[nums.length - 2], nums[nums.length - 1]], tm); break;
          case "Tf": fontSize = nums[nums.length - 1]; break;
          case "TJ":
          case "Tj": {
            const text = decodeStrings(operands[operands.length - 1] ?? "");
            const m = multiply(tm, ctm);
            if (text.trim()) runs.push({ page: index + 1, x: m[4], y: m[5], fontSize: fontSize * Math.abs(m[3]), text });
            break;
          }
        }
        operands.length = 0;
      } else {
        operands.push(t);
      }
    }
  });
  return runs;
}

/** Text of one page in drawing order, runs joined by a space (for "contains" assertions). */
export const pageText = (runs: TextRun[], page: number) =>
  runs
    .filter((r) => r.page === page)
    .map((r) => r.text)
    .join(" ")
    .replace(/\s+/g, " ");
