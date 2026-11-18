import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { extractTextRuns, nonWinAnsiChars, pageText, type TextRun } from "../pdf-text";
import { renderPdf } from "@/lib/pdf/render";
import { buildBranding } from "@/modules/documents/branding";
import { DocumentPreview } from "@/modules/documents/templates/document-preview";
import { FALLBACK_PROFILE, type PublicSchoolProfile } from "@/modules/settings/settings.public";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

const profile: PublicSchoolProfile = {
  name: "Demo Public School",
  shortCode: "DPS",
  affiliationNo: "1234567",
  board: "CBSE",
  address: { line1: "12 School Road", line2: null, city: "Patna", district: null, state: "Bihar", pinCode: "800001", country: "India" },
  phones: ["+919876543210"],
  email: "office@example.test",
  website: "https://school.example.test",
  logoFileId: "logo1",
  timezone: "Asia/Kolkata",
};

const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
/** Info-dictionary strings may be literal "(…)" or UTF-16 hex "<FEFF…>". */
const infoContains = (pdf: Buffer, text: string) => {
  const raw = pdf.toString("latin1");
  const hex = Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase();
  return raw.includes(`(${text}`) || raw.toUpperCase().includes(hex);
};

describe("branding", () => {
  it("builds header lines from the profile", () => {
    const b = buildBranding(profile, { bytes: PNG, mimeType: "image/png" });
    expect(b.affiliationLine).toBe("CBSE · Affiliation No. 1234567");
    expect(b.addressLines).toEqual(["12 School Road", "Patna, Bihar – 800001"]);
    expect(b.contactLine).toContain("office@example.test");
    expect(b.logo?.format).toBe("png");
  });
  it("omits what isn't configured and ignores unsupported logo types", () => {
    const b = buildBranding(FALLBACK_PROFILE, { bytes: PNG, mimeType: "image/webp" });
    expect(b.name).toBe("School");
    expect(b.addressLines).toEqual([]);
    expect(b.contactLine).toBeNull();
    expect(b.affiliationLine).toBeNull();
    expect(b.logo).toBeNull();
  });
});

describe("PDF rendering", () => {
  it("renders a valid one-page branded A4 PDF with metadata (with logo)", async () => {
    const pdf = await renderPdf(createElement(DocumentPreview, { branding: buildBranding(profile, { bytes: PNG, mimeType: "image/png" }), generatedAt: new Date() }));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pageCount(pdf)).toBe(1);
    expect(infoContains(pdf, "Demo Public School")).toBe(true);
    expect(pdf.toString("latin1")).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+595\.2[0-9]*\s+841\.8[0-9]*\s*\]/); // A4 in points
    expect(pdf.toString("latin1")).toMatch(/\/Subtype\s*\/Image/); // logo embedded
  }, 30_000);
  it("works without a logo or configured profile (safe defaults)", async () => {
    const pdf = await renderPdf(createElement(DocumentPreview, { branding: buildBranding(FALLBACK_PROFILE), generatedAt: new Date() }));
    expect(pageCount(pdf)).toBe(1);
    expect(pdf.toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
  }, 30_000);
  it("flows long content onto further pages (header/footer repeat)", async () => {
    const pdf = await renderPdf(createElement(DocumentPreview, { branding: buildBranding(profile), generatedAt: new Date(), extraParagraphs: 60 }));
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

// G7 B3: the footer was drawn ~6200 pt below the A4 page (page-level lineHeight + absolute footer),
// so "Generated …" and "Page X of Y" never printed. These tests read real text coordinates.
describe("PDF letterhead footer (G7 B3)", () => {
  const A4_HEIGHT = 841.89;
  const A4_WIDTH = 595.28;
  const PAGE_PADDING_BOTTOM = 56; // styles.page.paddingBottom: body text must stay above this
  const generatedAt = new Date("2026-11-09T19:14:00Z"); // 10 Nov 2026, 00:44 in Asia/Kolkata
  const isPageNumber = (r: TextRun) => /Page \d+ of \d+/.test(r.text);
  /** Footer runs = everything on the baseline of the "Page X of Y" run (the footer is one row). */
  const footerBaseline = (onPage: TextRun[]) => onPage.find(isPageNumber)?.y;

  function checkPages(runs: TextRun[], pages: number) {
    for (let page = 1; page <= pages; page++) {
      const onPage = runs.filter((r) => r.page === page);
      const baseline = footerBaseline(onPage);
      expect(baseline).toBeDefined();
      const footer = onPage.filter((r) => Math.abs(r.y - (baseline ?? NaN)) < 0.01);
      const body = onPage.filter((r) => !footer.includes(r));
      expect(footer.some((r) => r.text.includes("Generated"))).toBe(true);
      const text = pageText(runs, page);
      // visible: both footer parts are on this page, inside its boundaries
      expect(text).toContain(`Page ${page} of ${pages}`);
      expect(text).toMatch(/Demo Public School · Generated 10 Nov 2026, 12:44\sam/);
      expect(footer.length).toBeGreaterThanOrEqual(2);
      for (const r of footer) {
        expect(r.y).toBeGreaterThan(0);
        expect(r.y + r.fontSize).toBeLessThan(PAGE_PADDING_BOTTOM); // inside the bottom margin
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x).toBeLessThan(A4_WIDTH);
      }
      // no overlap: every body line sits above the footer's top edge
      const footerTop = Math.max(...footer.map((r) => r.y + r.fontSize));
      const lowestBody = Math.min(...body.map((r) => r.y));
      expect(lowestBody).toBeGreaterThan(footerTop);
      for (const r of body) expect(r.y).toBeLessThan(A4_HEIGHT);
      // header repeats on every page
      expect(text).toContain("Demo Public School");
    }
  }

  it("prints the generated date/time and page number inside a single A4 page, below the body", async () => {
    const pdf = await renderPdf(createElement(DocumentPreview, { branding: buildBranding(profile, { bytes: PNG, mimeType: "image/png" }), generatedAt }));
    checkPages(extractTextRuns(pdf), 1);
  }, 30_000);

  it("repeats a visible, non-overlapping footer with correct numbering on every page of a long document", async () => {
    const pdf = await renderPdf(createElement(DocumentPreview, { branding: buildBranding(profile), generatedAt, extraParagraphs: 60 }));
    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThanOrEqual(2);
    const runs = extractTextRuns(pdf);
    expect(new Set(runs.map((r) => r.page)).size).toBe(pages);
    checkPages(runs, pages);
  }, 30_000);

  it("keeps the body line spacing at 1.4 × 10.5 pt (lineHeight moved off <Page>)", async () => {
    const pdf = await renderPdf(createElement(DocumentPreview, { branding: buildBranding(profile), generatedAt, extraParagraphs: 3 }));
    const fillerLines = extractTextRuns(pdf)
      .filter((r) => r.fontSize === 10.5)
      .map((r) => r.y);
    const gaps = [...new Set(fillerLines.map((y) => y.toFixed(2)))].map(Number).sort((a, b) => b - a);
    const steps = gaps.slice(1).map((y, i) => +(gaps[i] - y).toFixed(2));
    expect(steps).toContain(14.7);
  }, 30_000);
});

// G7 B4: "Settings → School profile" printed as "Settings ' School profile" — the built-in PDF
// fonts (Helvetica, WinAnsiEncoding) have no glyph for "→".
describe("PDF text uses only characters the built-in fonts can draw (G7 B4)", () => {
  it("renders the preview sentence with a plain '>' separator", async () => {
    const pdf = await renderPdf(createElement(DocumentPreview, { branding: buildBranding(profile), generatedAt: new Date() }));
    const text = pageText(extractTextRuns(pdf), 1);
    expect(text).toContain("The header above comes from Settings > School profile;");
    expect(text).not.toContain("Settings ' School profile");
  }, 30_000);

  it("document templates and branding contain no characters outside WinAnsi (e.g. → ✓ ₹)", () => {
    const dir = join(process.cwd(), "src", "modules", "documents");
    const files = [join(dir, "branding.ts"), ...readdirSync(join(dir, "templates")).map((f) => join(dir, "templates", f))];
    for (const file of files) expect({ file, bad: nonWinAnsiChars(readFileSync(file, "utf8")) }).toEqual({ file, bad: [] });
    expect(nonWinAnsiChars("Settings → School profile")).toEqual(["→"]); // the checker itself works
  });
});
