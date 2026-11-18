/**
 * CSV building for exports (pure — unit tested). RFC 4180 quoting, CRLF line ends and a UTF-8 BOM so
 * spreadsheet software opens Indian-language names correctly.
 *
 * Formula-injection guard (OWASP "CSV injection"), applied to every cell including staff-typed values:
 *  - a cell whose first non-whitespace character is = + - @ (or their full-width forms ＝ ＋ － ＠, which some
 *    spreadsheet apps normalise), or that starts with a tab / carriage return / other control character, is
 *    prefixed with an apostrophe, so it is shown as text instead of being evaluated;
 *  - S-11: a cell is quoted whenever it contains a field separator any spreadsheet locale may use — comma,
 *    SEMICOLON or tab — or a quote / line break, so `Class 1;=HYPERLINK(…)` can't be split into a second,
 *    evaluated cell by a `;`-separated (European / some Indian-locale) spreadsheet.
 */
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@＝＋－＠]|^[\t\r\u0000-\u001f]/;
const NEEDS_QUOTES = /[",;\t\r\n]/;

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string {
  const line = (cells: readonly (string | number | boolean | null | undefined)[]) => cells.map(csvCell).join(",");
  return `﻿${[line(header), ...rows.map(line)].join("\r\n")}\r\n`;
}
