import "server-only";

import Papa from "papaparse";

/**
 * CSV serialization for contact export. We use papaparse for parsing (handles
 * quoted fields, embedded newlines, BOM, etc.) and a tiny in-house writer for
 * output — papaparse's `unparse` works fine but its bundle is a bit hefty
 * to ship to the client and we don't need every option.
 */

/** Quote-and-escape a single cell per RFC 4180. */
function escapeCell(value: string): string {
  // Wrap in quotes if it contains a delimiter, quote, or newline. Always
  // safer to over-quote than under-quote.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialize rows to CSV. The header row is the column order; each row is an
 * object keyed by the same column names. Missing keys render as empty.
 *
 * Prepends a UTF-8 BOM so Excel opens UTF-8 files correctly without
 * round-tripping through "Import Text Wizard".
 */
export function serializeCsv(columns: string[], rows: Array<Record<string, string>>): string {
  const lines: string[] = [];
  lines.push(columns.map(escapeCell).join(","));
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c] ?? "")).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

/**
 * Parse a CSV string into an array of header-keyed rows. Header normalization
 * is the caller's job — we hand back what was in row 1 verbatim, just trimmed.
 *
 * Throws on malformed input that papaparse can't recover from. Per-row errors
 * (e.g. mismatched column count) are tolerated; the row is included with the
 * cells we did manage to parse.
 */
export function parseCsv(input: string): ParsedCsv {
  // Strip a UTF-8 BOM if present — Excel writes one on save.
  const cleaned = input.replace(/^﻿/, "");
  const parsed = Papa.parse<string[]>(cleaned, {
    skipEmptyLines: true,
    // We want raw arrays so we control header dedup and trimming below.
    // (papaparse's `header: true` would auto-collapse duplicate columns.)
  });
  if (parsed.errors.length > 0) {
    // Surface only fatal errors. Per-row delimiter issues are common in
    // real-world exports and shouldn't fail the whole file.
    const fatal = parsed.errors.find((e) => e.type === "Quotes" || e.code === "MissingQuotes");
    if (fatal) {
      throw new Error(`CSV parse failed: ${fatal.message}`);
    }
  }
  const data = parsed.data;
  if (data.length === 0) return { headers: [], rows: [] };
  const headers = (data[0] ?? []).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i] ?? [];
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      if (!key) continue;
      // Trim values too — keep CSV minor formatting differences out of the
      // dedupe key (especially phone numbers, where leading spaces are
      // common in copy-paste exports).
      const cell = (row[j] ?? "").trim();
      if (cell) obj[key] = cell;
    }
    rows.push(obj);
  }
  return { headers, rows };
}
