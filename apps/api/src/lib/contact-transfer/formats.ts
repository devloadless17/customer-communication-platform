/**
 * The format seam for contact import/export.
 *
 * Everything above this file works on `Row = Record<string, string>` and never
 * branches on CSV-vs-Excel. Adding a third format (ODS, JSON-lines) means one
 * new sink + one new source and zero changes to the runners — the same
 * discipline the MessagingProvider interface gives us for channels (CLAUDE.md
 * §5). Both interfaces are deliberately tiny: a header, chunks of rows, a
 * finish.
 *
 * Everything here STREAMS. A 100k-contact export is ~25 MB as one CSV string
 * and considerably worse as an in-memory workbook; on a 2 GB-limit API
 * container (§16) that is not a rounding error. Sinks write to a file
 * descriptor and sources pull off a read stream, so peak heap is one batch
 * regardless of file size.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import type { Writable } from "node:stream";

import ExcelJS from "exceljs";
import Papa from "papaparse";

import { csvHeader, csvRows } from "@/lib/csv";

export type Row = Record<string, string>;

/** Writes a tabular document. Call `writeHeader` once, then `writeRows` N times, then `finish`. */
export interface RowSink {
  writeHeader(columns: string[]): Promise<void>;
  writeRows(rows: Row[]): Promise<void>;
  /** Flush + close. Safe to call once; the caller owns the underlying path. */
  finish(): Promise<void>;
}

/** Reads a tabular document. */
export interface RowSource {
  /** Header row, trimmed. Available before iterating. */
  headers(): Promise<string[]>;
  /**
   * Data rows, keyed by header. Yields `{ rowNumber, cells }` where rowNumber
   * is the 1-based spreadsheet line (header = 1, first data row = 2) so error
   * reports point at what the user sees in Excel.
   */
  rows(): AsyncIterable<{ rowNumber: number; cells: Row }>;
  /** Release file handles. Always called, including on an aborted iteration. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------

/**
 * `stream.write()` returning false means the kernel buffer is full. Ignoring it
 * is how a "streaming" writer quietly buffers the entire document in memory —
 * exactly the bug this module exists to avoid — so every write awaits drain.
 */
async function writeAndDrain(stream: Writable, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * CSV sink. Delegates to the EXISTING `csvHeader`/`csvRows` in lib/csv.ts —
 * `escapeCell`'s OWASP formula-injection defuse and the UTF-8 BOM must stay a
 * single implementation. Contact names arrive from inbound WhatsApp messages
 * and from imported files; both are attacker-controlled, and a name of
 * `=cmd|'/c calc'!A0` firing when an operator opens their own export is a real
 * finding, not a theoretical one.
 */
export function csvSink(path: string): RowSink {
  const out = createWriteStream(path, { encoding: "utf-8" });
  let columns: string[] = [];
  return {
    async writeHeader(cols) {
      columns = cols;
      await writeAndDrain(out, csvHeader(cols));
    },
    async writeRows(rows) {
      if (rows.length === 0) return;
      await writeAndDrain(out, csvRows(columns, rows));
    },
    async finish() {
      out.end();
      await once(out, "finish");
    },
  };
}

/**
 * CSV source. papaparse in STEP mode over a read stream: rows are handed back
 * one at a time and never accumulate. The existing `parseCsv` helper takes a
 * whole string and so can't be reused here — it stays the right tool for the
 * small-payload callers it already serves.
 *
 * papaparse's step callback is push-based and we need pull-based async
 * iteration, so this bridges the two with a bounded queue: the parser is paused
 * once HIGH_WATER rows are buffered and resumed as the consumer drains. Without
 * the pause a 200k-row file would materialize entirely in the queue — the exact
 * thing streaming is supposed to prevent.
 */
export function csvSource(path: string): RowSource {
  const HIGH_WATER = 2_000;

  const stream = createReadStream(path, { encoding: "utf-8" });
  let headers: string[] = [];
  let headersResolved = false;
  let resolveHeaders: (h: string[]) => void;
  let rejectHeaders: (e: unknown) => void;
  const headersPromise = new Promise<string[]>((res, rej) => {
    resolveHeaders = res;
    rejectHeaders = rej;
  });

  const queue: Array<{ rowNumber: number; cells: Row }> = [];
  let done = false;
  let failure: Error | null = null;
  let parser: Papa.Parser | null = null;
  let notify: (() => void) | null = null;
  const wake = (): void => {
    notify?.();
    notify = null;
  };

  let lineNumber = 0;

  Papa.parse<string[]>(stream as unknown as NodeJS.ReadableStream, {
    skipEmptyLines: true,
    // Raw arrays: we own header trimming + duplicate handling, and papaparse's
    // `header: true` silently collapses duplicate columns.
    step: (result, p) => {
      parser = p;
      const record = result.data;
      lineNumber += 1;
      if (lineNumber === 1) {
        // Strip a UTF-8 BOM off the first header — Excel writes one on save.
        headers = record.map((h, i) => (i === 0 ? h.replace(/^\uFEFF/, "") : h).trim());
        headersResolved = true;
        resolveHeaders(headers);
        return;
      }
      const cells: Row = {};
      for (let i = 0; i < headers.length; i++) {
        const key = headers[i];
        if (!key) continue;
        const cell = (record[i] ?? "").trim();
        if (cell) cells[key] = cell;
      }
      queue.push({ rowNumber: lineNumber, cells });
      if (queue.length >= HIGH_WATER) p.pause();
      wake();
    },
    complete: () => {
      done = true;
      // A file with a header and no data rows still needs to resolve.
      if (!headersResolved) resolveHeaders(headers);
      wake();
    },
    error: (err: Error) => {
      failure = err;
      done = true;
      if (!headersResolved) rejectHeaders(err);
      wake();
    },
  });

  return {
    headers: () => headersPromise,
    async *rows() {
      for (;;) {
        if (queue.length > 0) {
          const next = queue.shift()!;
          // Resume once the consumer has drained the buffer to half — resuming
          // at zero would thrash pause/resume once per row.
          if (queue.length < HIGH_WATER / 2) parser?.resume();
          yield next;
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((res) => {
          notify = res;
        });
      }
    },
    async close() {
      parser?.abort();
      stream.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/**
 * Excel sink via ExcelJS's streaming WorkbookWriter.
 *
 * `useSharedStrings: false` is load-bearing: the shared-string table is a
 * process-lifetime map of every distinct string in the workbook, so with it on,
 * a 100k-contact export holds every name, email and tag in heap until finalize
 * — precisely the unbounded growth streaming is meant to remove. Inline strings
 * cost a little file size and buy flat memory. `useStyles: false` for the same
 * reason (a style record per cell).
 *
 * `row.commit()` per row flushes that row to disk and drops it.
 */
export function xlsxSink(path: string, sheetName = "Contacts"): RowSink {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: path,
    useSharedStrings: false,
    useStyles: false,
  });
  // Excel rejects these characters in a sheet name and caps it at 31 chars;
  // the name is derived from user-visible text, so sanitize rather than throw.
  const safeSheet = sheetName.replace(/[*?:/\\[\]]/g, " ").slice(0, 31) || "Contacts";
  const sheet = workbook.addWorksheet(safeSheet, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  let columns: string[] = [];

  return {
    async writeHeader(cols) {
      columns = cols;
      // `key` lets addRow take an object; `header` is the visible text.
      sheet.columns = cols.map((c) => ({ key: c, header: c, width: 22 }));
      // ExcelJS materializes the header row from `columns` — commit it so it
      // lands on disk like every other row.
      sheet.getRow(1).commit();
    },
    async writeRows(rows) {
      for (const row of rows) {
        // Build positionally rather than by key: a header could collide with an
        // ExcelJS-reserved property name, and an array has no such ambiguity.
        // Every value is written as a STRING, which is what keeps a phone
        // number like 15551234567 from becoming 1.5551E+10 when the file is
        // reopened, and keeps a leading `+` or `0` intact.
        sheet.addRow(columns.map((c) => row[c] ?? "")).commit();
      }
    },
    async finish() {
      sheet.commit();
      await workbook.commit();
    },
  };
}

/**
 * Convert whatever ExcelJS hands back for a cell into the plain string the rest
 * of the pipeline expects.
 *
 * This function is where naive spreadsheet importers break. A phone number
 * typed into Excel is stored as a NUMBER, so `String(value)` on a long one
 * yields "1.5551234567e+10" and every row fails phone validation with a
 * baffling message. Formula cells hand back `{ formula, result }`. Hyperlinks
 * and rich text hand back objects with a `.text`. Dates come back as `Date`.
 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    // Integers render in full (no exponent) — the phone-number case.
    // Non-integers keep their decimals but still avoid exponent notation.
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    // Formula cell: prefer the cached result Excel computed. `result` can
    // itself be an error object ({ error: '#N/A' }) — recursing handles that
    // by falling through to "" rather than emitting "[object Object]".
    if ("formula" in v || "sharedFormula" in v) return cellToString(v.result);
    // Rich text: { richText: [{ text }, …] } — one run per formatting change,
    // so "Ali <b>Ahmad</b>" arrives as ["Ali ", "Ahmad"]. Concatenate the runs
    // RAW and trim only the result: trimming each run individually eats the
    // space between them and silently renames the contact to "AliAhmad".
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((part) => {
          const t = (part as Record<string, unknown>).text;
          return typeof t === "string" ? t : "";
        })
        .join("")
        .trim();
    }
    // Hyperlink: { text, hyperlink }.
    if (typeof v.text === "string") return v.text.trim();
    // Error cell ({ error: '#DIV/0!' }) → empty, not the literal error text.
    if ("error" in v) return "";
  }
  return "";
}

/**
 * Excel source via ExcelJS's streaming WorkbookReader.
 *
 * FIRST worksheet only — a workbook with "Contacts" plus a "Notes" tab should
 * import the contacts, not concatenate the notes. `extraSheets` reports the
 * ignored ones so the UI can say so instead of silently dropping data the user
 * expected to be read.
 *
 * ONE shared iterator backs both `headers()` and `rows()`. ExcelJS's reader is
 * PULL-based: nothing is parsed until the generator is pumped. An earlier
 * version had `headers()` await a promise the generator resolved, which
 * deadlocked every caller — and every caller reads headers before iterating
 * (the import runner needs them to build the column mapping, the preview
 * endpoint to render the mapping UI). So `headers()` pumps the iterator itself
 * until the header row lands, and `rows()` resumes from the same one.
 */
export function xlsxSource(path: string): RowSource & { extraSheets: () => string[] } {
  const skipped: string[] = [];
  let headers: string[] = [];
  let headersRead = false;
  /** Rows headers() had to pull off the iterator, replayed by rows(). */
  const pending: Array<{ rowNumber: number; cells: Row }> = [];

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    // 'emit' streams worksheets/rows instead of building a workbook in memory.
    worksheets: "emit",
    // Shared strings must be cached to resolve string cells at all; ExcelJS
    // holds only the string table, not the rows.
    sharedStrings: "cache",
    hyperlinks: "cache",
    // MEASURED, not assumed: with styles:'ignore' a date cell comes back as the
    // raw Excel serial number (2020-01-02 → 43832.1278…) because ExcelJS needs
    // the number-format record to know the cell is a date at all. Caching
    // styles makes it a real Date, which cellToString renders as ISO. The style
    // table is per-workbook and small — unlike shared strings, it does not grow
    // with row count, so this doesn't reintroduce the memory problem.
    styles: "cache",
    entries: "ignore",
  });

  async function* iterate(): AsyncGenerator<{ rowNumber: number; cells: Row }> {
    let first = true;
    for await (const worksheet of reader) {
      if (!first) {
        // WorksheetReader's public typings omit name/id even though the
        // runtime object carries both.
        const meta = worksheet as unknown as { name?: string; id?: number };
        skipped.push(meta.name ?? `sheet ${meta.id ?? "?"}`);
        // Drain so the reader can advance to the next entry.
        for await (const _row of worksheet) {
          void _row;
        }
        continue;
      }
      first = false;
      for await (const row of worksheet) {
        // `row.values` is 1-INDEXED with a hole at [0] — a classic ExcelJS
        // footgun. Slice it off rather than carrying an undefined column.
        const values = (row.values as unknown[]) ?? [];
        const cells = values.slice(1).map(cellToString);
        if (!headersRead) {
          headers = cells.map((h) => h.replace(/^\uFEFF/, "").trim());
          headersRead = true;
          continue;
        }
        const obj: Row = {};
        for (let i = 0; i < headers.length; i++) {
          const key = headers[i];
          if (!key) continue;
          const cell = cells[i] ?? "";
          if (cell) obj[key] = cell;
        }
        // Excel files routinely carry thousands of trailing rows that are
        // formatted but empty. Skipping them here keeps them out of the row
        // count, the error report, and the "you exceeded the row cap" check.
        if (Object.keys(obj).length === 0) continue;
        // ExcelJS's own row.number is the true spreadsheet line, which is what
        // an error report must cite (blank rows shift it).
        yield { rowNumber: row.number, cells: obj };
      }
    }
  }

  // The single live iterator. Created once so headers() and rows() share
  // position in the file.
  const iterator = iterate();

  return {
    async headers() {
      if (headersRead) return headers;
      // Pump one step. The generator consumes the header row without yielding,
      // so this either surfaces the first DATA row (header already parsed) or
      // hits end-of-file on a header-only sheet — both leave `headers` set.
      const next = await iterator.next();
      if (!next.done) pending.push(next.value);
      return headers;
    },
    async *rows() {
      // Replay anything headers() had to pull off the iterator to get there.
      while (pending.length > 0) yield pending.shift()!;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    },
    extraSheets: () => skipped,
    async close() {
      // WorkbookReader owns its file handle and releases it when the iteration
      // completes or the generator's `finally` runs (including on an early
      // `break`, which is what an aborted import does).
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type TransferFormat = "csv" | "xlsx";

export function createSink(format: TransferFormat, path: string, sheetName?: string): RowSink {
  return format === "xlsx" ? xlsxSink(path, sheetName) : csvSink(path);
}

export function createSource(format: TransferFormat, path: string): RowSource {
  return format === "xlsx" ? xlsxSource(path) : csvSource(path);
}
