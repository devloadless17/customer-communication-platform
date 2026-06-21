"use client";

import { useEffect, useRef, useState } from "react";

import { Download, FileUp, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { apiFetch } from "@/lib/api/client-fetch";

/**
 * Modal for importing contacts from a CSV. Two steps:
 *
 *   1. Choose file → parse the header + rows in the browser → MAP each CSV
 *      column to a recognized contact field (phone_number REQUIRED), with a
 *      preview of the first rows and a total count.
 *   2. Import → a single multipart POST to /api/contacts/import → progress →
 *      a success / partial-failure summary (created / skipped / errored).
 *
 * The server contract is UNCHANGED: it classifies columns by HEADER NAME. So
 * step 2 doesn't send a mapping — instead it REBUILDS the CSV client-side with
 * the canonical header names the user chose (only mapped, non-ignored columns),
 * then uploads that. This keeps the upgrade entirely client-side.
 *
 * The backend dedupes on phone number — existing rows are left untouched, only
 * new ones are appended — so re-uploading the same file twice is safe. After a
 * successful import the parent reloads the page so new rows + any field changes
 * are reflected.
 */

/** A canonical target column the importer recognizes, plus its display label. */
interface FieldOption {
  /** The exact header string the server classifies on. */
  value: string;
  /** Human label shown in the mapping dropdown. */
  label: string;
}

/** Built-in fields, in the order the template lists them. Header strings here
 *  MUST match what the server's `classify()` recognizes. */
const BUILTIN_FIELDS: FieldOption[] = [
  { value: "phone_number", label: "Phone number" },
  { value: "name", label: "Name" },
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "email", label: "Email" },
  { value: "location", label: "Location" },
  { value: "language", label: "Language" },
  { value: "country", label: "Country" },
  { value: "tags", label: "Tags" },
  { value: "stage", label: "Stage" },
];
const BUILTIN_VALUES = new Set(BUILTIN_FIELDS.map((f) => f.value));

/** Sentinel mapping target = "don't import this column". */
const IGNORE = "";

const PREVIEW_ROWS = 5;

interface ParsedFile {
  headers: string[];
  /** ALL data rows (raw cells). The map step previews only the first few; the
   *  import step rebuilds the upload from these, so it never depends on the
   *  file input ref still being mounted. */
  rows: string[][];
}

export function ImportContactsDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  /** CSV column index → chosen target header (or IGNORE). */
  const [mapping, setMapping] = useState<string[]>([]);
  /** Team custom-field labels (recognized as columns), loaded lazily. */
  const [customFields, setCustomFields] = useState<FieldOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pull the recognized custom-field labels from the import template's header
  // row — it's the same recognized-column set the server builds, so we never
  // drift from the importer. Failure is non-fatal: built-in fields still work.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/contacts/template", { method: "GET" });
        if (!res.ok) return;
        const text = await res.text();
        const { headers } = parseCsv(text);
        const builtinHeaders = new Set(BUILTIN_FIELDS.map((f) => f.value));
        const extras = headers
          .filter((h) => h && !builtinHeaders.has(h.toLowerCase()))
          .map((h) => ({ value: h, label: h }));
        if (!cancelled) setCustomFields(extras);
      } catch {
        // Ignore — built-in mapping still functions.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fieldOptions: FieldOption[] = [...BUILTIN_FIELDS, ...customFields];

  function onFilePicked(file: File | null) {
    setParseError(null);
    setError(null);
    if (!file) {
      setParsed(null);
      setMapping([]);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setParseError("Couldn't read the file. Try again.");
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      let pc: { headers: string[]; rows: string[][] };
      try {
        pc = parseCsv(text);
      } catch {
        setParseError("Couldn't parse the CSV. Check the file and try again.");
        setParsed(null);
        setMapping([]);
        return;
      }
      if (pc.headers.length === 0 || pc.rows.length === 0) {
        setParseError("This CSV has no data rows.");
        setParsed(null);
        setMapping([]);
        return;
      }
      setParsed({ headers: pc.headers, rows: pc.rows });
      // Auto-map by exact/normalized header match so a well-formed export needs
      // no manual work; the user adjusts only what didn't match. De-dupe: if two
      // columns guess the same field, only the first keeps it (mirrors the
      // one-source-per-field rule `setColumnTarget` enforces on manual edits).
      const seen = new Set<string>();
      setMapping(
        pc.headers.map((h) => {
          const target = guessTarget(h, fieldOptions);
          if (target === IGNORE || seen.has(target)) return IGNORE;
          seen.add(target);
          return target;
        }),
      );
    };
    reader.readAsText(file);
  }

  function setColumnTarget(colIndex: number, target: string) {
    setMapping((prev) => {
      const next = [...prev];
      // A target (other than IGNORE) can only map from one column — clear any
      // prior column pointing at the same field so we never emit a duplicate
      // header (which the server would read as two of the same field).
      if (target !== IGNORE) {
        for (let i = 0; i < next.length; i++) {
          if (i !== colIndex && next[i] === target) next[i] = IGNORE;
        }
      }
      next[colIndex] = target;
      return next;
    });
  }

  const phoneMapped = mapping.includes("phone_number");

  async function submit() {
    if (!parsed || !phoneMapped) return;
    setError(null);
    setSubmitting(true);
    // Hard timeout. Without it, a stuck network leaves the dialog spinning
    // forever — the user has no Cancel affordance and no signal anything's
    // wrong. 120s is generous for a 1 MiB CSV on a slow uplink.
    const abort = new AbortController();
    const timeoutId = window.setTimeout(() => abort.abort(), 120_000);
    try {
      // Rebuild a CSV using the canonical header names the user mapped, keeping
      // only mapped (non-ignored) columns. The server classifies on these exact
      // headers — no server change needed. Built from `parsed` (not the file
      // input, which is unmounted on the map step).
      const rebuilt = buildMappedCsv(parsed, mapping);
      const form = new FormData();
      form.append("file", rebuilt, "import.csv");
      const res = await apiFetch("/api/contacts/import", {
        method: "POST",
        body: form,
        signal: abort.signal,
      });
      const body = (await res.json().catch(() => ({}))) as
        | ImportResult
        | { error?: string };
      if (!res.ok) {
        setError(("error" in body && body.error) || "Import failed");
        return;
      }
      setResult(body as ImportResult);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("Import timed out. Try a smaller file or check your connection.");
      } else {
        setError("Network error. Please try again.");
      }
    } finally {
      window.clearTimeout(timeoutId);
      setSubmitting(false);
    }
  }

  function close() {
    if (result) onImported();
    else onClose();
  }

  async function downloadTemplate() {
    const res = await apiFetch("/api/contacts/template", { method: "GET" });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts-template.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    // Dismiss (Escape or backdrop) routes through `close()` so a completed
    // import still triggers the parent reload, same as the X / Done buttons.
    <Dialog open onClose={close}>
      <DialogContent
        className={parsed && !result ? "max-w-2xl" : "max-w-md"}
        labelledBy="import-contacts-title"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="import-contacts-title" className="text-base font-semibold">
            Import contacts
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {result ? (
          <ImportResultView result={result} onClose={close} />
        ) : !parsed ? (
          <ChooseFileStep
            parseError={parseError}
            onPick={onFilePicked}
            fileInputRef={fileInputRef}
            onCancel={onClose}
            onDownloadTemplate={downloadTemplate}
          />
        ) : (
          <MapStep
            parsed={parsed}
            mapping={mapping}
            fieldOptions={fieldOptions}
            phoneMapped={phoneMapped}
            submitting={submitting}
            error={error}
            onChangeTarget={setColumnTarget}
            onBack={() => {
              setParsed(null);
              setMapping([]);
              setError(null);
            }}
            onSubmit={submit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — choose file
// ---------------------------------------------------------------------------

function ChooseFileStep({
  parseError,
  onPick,
  fileInputRef,
  onCancel,
  onDownloadTemplate,
}: {
  parseError: string | null;
  onPick: (file: File | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onDownloadTemplate: () => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground">
        Upload a CSV, then map each column to a contact field. A{" "}
        <code className="rounded bg-muted px-1">phone_number</code> column is
        required. Existing contacts are matched by phone number and left
        untouched — only new rows are added.
      </p>

      {/* Format guidance — the phone format is the #1 import mistake. */}
      <div className="rounded-md border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground space-y-1.5">
        <div>
          <span className="font-medium text-foreground">Phone number:</span>{" "}
          full international number <span className="font-medium">with the
          country code</span>, e.g.{" "}
          <code className="rounded bg-muted px-1">15551234567</code> for the US
          or <code className="rounded bg-muted px-1">96170921116</code> for
          Lebanon. The leading{" "}
          <code className="rounded bg-muted px-1">+</code> is optional (both{" "}
          <code className="rounded bg-muted px-1">+15551234567</code> and{" "}
          <code className="rounded bg-muted px-1">15551234567</code> work);
          spaces and dashes are fine too. A local number without the country
          code won't reach anyone.
        </div>
        <div>
          <span className="font-medium text-foreground">Tags:</span>{" "}
          one <code className="rounded bg-muted px-1">tags</code> column,
          separate multiple with a comma —{" "}
          <code className="rounded bg-muted px-1">VIP, Lead</code>. New tag names
          are created automatically. Leave blank for none.
        </div>
        <div>
          <span className="font-medium text-foreground">Stage:</span>{" "}
          one <code className="rounded bg-muted px-1">stage</code> column with
          the stage name. Blank or an unknown name uses your default stage.
        </div>
        <div className="text-muted-foreground/70">
          Tip: in Excel/Sheets, format the phone column as{" "}
          <span className="font-medium">Text</span> so long numbers aren't
          mangled into <code className="rounded bg-muted px-1">9.6E+10</code>.
        </div>
      </div>

      <button
        type="button"
        onClick={onDownloadTemplate}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Download className="size-3.5" />
        Download template
        <span className="text-3xs text-muted-foreground/60">
          (with an example row + your fields)
        </span>
      </button>
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="flex w-full min-w-0 items-center justify-center gap-2 rounded-md border border-dashed border-border bg-background px-4 py-8 text-sm hover:bg-accent hover:text-foreground"
      >
        <FileUp className="size-4 shrink-0" />
        <span className="min-w-0 truncate">
          {fileName ?? "Choose a .csv file"}
        </span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setFileName(f?.name ?? null);
          onPick(f);
        }}
      />

      {parseError && (
        <div
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {parseError}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — map columns + preview
// ---------------------------------------------------------------------------

function MapStep({
  parsed,
  mapping,
  fieldOptions,
  phoneMapped,
  submitting,
  error,
  onChangeTarget,
  onBack,
  onSubmit,
}: {
  parsed: ParsedFile;
  mapping: string[];
  fieldOptions: FieldOption[];
  phoneMapped: boolean;
  submitting: boolean;
  error: string | null;
  onChangeTarget: (colIndex: number, target: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const totalRows = parsed.rows.length;
  const previewRows = parsed.rows.slice(0, PREVIEW_ROWS);
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Map each column to a contact field. Columns set to{" "}
          <span className="font-medium text-foreground">Don&apos;t import</span>{" "}
          are skipped.
        </p>
        <span className="shrink-0 text-xs text-muted-foreground">
          {totalRows} row{totalRows === 1 ? "" : "s"}
        </span>
      </div>

      {/* Mapping + preview table. Each header gets a Select; rows below show
          the first parsed values so the user can confirm alignment. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {parsed.headers.map((h, i) => (
                <th
                  key={i}
                  className="min-w-[10rem] px-2 py-2 text-left align-top font-normal"
                >
                  <div className="mb-1.5 truncate font-medium text-foreground" title={h}>
                    {h || <span className="italic text-muted-foreground">(blank)</span>}
                  </div>
                  <Select
                    aria-label={`Map column ${h || i + 1}`}
                    value={mapping[i] ?? IGNORE}
                    onChange={(e) => onChangeTarget(i, e.target.value)}
                    className="h-8 text-xs"
                  >
                    <option value={IGNORE}>Don&apos;t import</option>
                    {fieldOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row, ri) => (
              <tr key={ri} className="border-b border-border last:border-0">
                {parsed.headers.map((_, ci) => (
                  <td
                    key={ci}
                    className="max-w-[14rem] truncate px-2 py-1.5 text-muted-foreground"
                    title={row[ci] ?? ""}
                  >
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalRows > previewRows.length && (
        <p className="text-xs text-muted-foreground/70">
          Showing the first {previewRows.length} of {totalRows} rows.
        </p>
      )}

      {!phoneMapped && (
        <div
          role="alert"
          className="rounded border border-warning-border bg-warning-bg px-2 py-1 text-xs text-warning-fg"
        >
          Map one column to <span className="font-medium">Phone number</span> to
          continue.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex justify-between gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button
          type="button"
          onClick={onSubmit}
          disabled={!phoneMapped || submitting}
        >
          {submitting && <Loader2 className="size-3.5 animate-spin" />}
          Import {totalRows} row{totalRows === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result summary
// ---------------------------------------------------------------------------

interface ImportResult {
  total: number;
  created: number;
  /** Soft-deleted contacts the import brought back (un-tombstoned). */
  revived: number;
  skippedExisting: number;
  errors: Array<{ row: number; reason: string }>;
  unknownColumns: string[];
  /** Stage names in the CSV that didn't match a team stage → used default. */
  unknownStages?: string[];
}

function ImportResultView({
  result,
  onClose,
}: {
  result: ImportResult;
  onClose: () => void;
}) {
  return (
    <div role="status" className="space-y-3 p-4">
      <div className="rounded-md border border-border bg-background p-3 text-sm">
        <div className="font-medium">
          Imported {result.created} new contact{result.created === 1 ? "" : "s"}.
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {result.revived > 0 && (
            <div>
              Restored {result.revived} previously-deleted contact
              {result.revived === 1 ? "" : "s"}.
            </div>
          )}
          {result.skippedExisting > 0 && (
            <div>
              Skipped {result.skippedExisting} that already existed (matched by phone
              number).
            </div>
          )}
          {result.errors.length > 0 && (
            <div>
              {result.errors.length} row{result.errors.length === 1 ? "" : "s"} couldn&apos;t
              be imported (see below).
            </div>
          )}
          <div>
            Processed {result.total} row{result.total === 1 ? "" : "s"} total.
          </div>
        </div>
      </div>

      {result.unknownColumns.length > 0 && (
        <div className="rounded-md border border-warning-border bg-warning-bg p-3 text-xs">
          <div className="font-medium text-warning-fg">
            Skipped these columns (not in your team fields):
          </div>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {result.unknownColumns.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="mt-2 text-muted-foreground">
            Add them as team fields in a contact panel, then re-import to bring those
            values in.
          </div>
        </div>
      )}

      {result.unknownStages && result.unknownStages.length > 0 && (
        <div className="rounded-md border border-warning-border bg-warning-bg p-3 text-xs">
          <div className="font-medium text-warning-fg">
            Unknown stage name{result.unknownStages.length === 1 ? "" : "s"} — used your
            default stage instead:
          </div>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {result.unknownStages.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <div className="mt-2 text-muted-foreground">
            Create the stage in Settings → Stages (or fix the spelling), then re-import
            to place those contacts.
          </div>
        </div>
      )}

      {result.errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
          <div className="font-medium text-destructive">
            {result.errors.length} row{result.errors.length === 1 ? "" : "s"} couldn&apos;t be
            imported:
          </div>
          <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-muted-foreground">
            {result.errors.slice(0, 50).map((e, i) => (
              <li key={i}>
                Row {e.row}: {e.reason}
              </li>
            ))}
            {result.errors.length > 50 && (
              <li className="list-none italic">
                …and {result.errors.length - 50} more
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="flex justify-end pt-1">
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimal CSV helpers (client-side)
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into a header row + data rows of raw cells. Handles
 * RFC 4180 quoting (embedded commas, quotes, and newlines inside `"..."`),
 * CRLF/LF line endings, and a leading UTF-8 BOM. Kept deliberately small —
 * papaparse lives in the api package only, and the constraint is no new web
 * dep. The server re-parses with papaparse, so this is just for mapping +
 * preview; we don't need every edge case papaparse handles.
 */
function parseCsv(input: string): { headers: string[]; rows: string[][] } {
  // Strip a leading UTF-8 BOM (U+FEFF). Written as an escape, not a literal,
  // to satisfy no-irregular-whitespace.
  const text = input.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let started = false; // any char seen on the current record

  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
    } else if (c === ",") {
      pushField();
      started = true;
    } else if (c === "\n") {
      pushRecord();
    } else if (c === "\r") {
      // CRLF: the \n handler runs next iteration. Lone \r also ends a record.
      if (text[i + 1] === "\n") continue;
      pushRecord();
    } else {
      field += c;
      started = true;
    }
  }
  // Flush a trailing record with no final newline.
  if (started || field.length > 0 || record.length > 0) {
    pushRecord();
  }

  // Drop fully-empty records (blank lines).
  const nonEmpty = records.filter(
    (r) => !(r.length === 1 && r[0]?.trim() === ""),
  );
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => r.map((cell) => cell.trim()));
  return { headers, rows };
}

// Cells beginning with one of these are interpreted as a formula by Excel /
// Sheets / LibreOffice — mirror the server-side defuse so the rebuilt upload
// isn't a CSV-injection vector either. (OWASP "CSV/Formula Injection".)
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

/** Quote-and-escape a cell per RFC 4180, with formula-injection defuse. */
function escapeCell(value: string): string {
  const safe = FORMULA_TRIGGERS.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Rebuild a CSV from the parsed rows + the user's column→field mapping, keeping
 * only mapped (non-ignored) columns and renaming each header to the canonical
 * name the server's `classify()` recognizes. The server re-parses this with
 * papaparse, so the contract is unchanged — we just hand it clean headers.
 */
function buildMappedCsv(parsed: ParsedFile, mapping: string[]): Blob {
  const keep: Array<{ index: number; header: string }> = [];
  for (let i = 0; i < parsed.headers.length; i++) {
    const target = mapping[i];
    if (target && target !== IGNORE) keep.push({ index: i, header: target });
  }
  const lines = [keep.map((k) => escapeCell(k.header)).join(",")];
  for (const row of parsed.rows) {
    lines.push(keep.map((k) => escapeCell(row[k.index] ?? "")).join(","));
  }
  const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
  return new Blob([csv], { type: "text/csv" });
}

/**
 * Guess the mapping target for a CSV header by matching the same aliases the
 * server's `classify()` accepts, so a well-formed export auto-maps and the
 * user only fixes the stragglers. Unknown → IGNORE.
 */
function guessTarget(header: string, options: FieldOption[]): string {
  const h = header.toLowerCase().trim();
  const builtin: Record<string, string> = {
    phone_number: "phone_number",
    phone: "phone_number",
    "phone number": "phone_number",
    name: "name",
    "full name": "name",
    full_name: "name",
    first_name: "first_name",
    firstname: "first_name",
    "first name": "first_name",
    given_name: "first_name",
    "given name": "first_name",
    last_name: "last_name",
    lastname: "last_name",
    "last name": "last_name",
    surname: "last_name",
    family_name: "last_name",
    "family name": "last_name",
    email: "email",
    "e-mail": "email",
    email_address: "email",
    location: "location",
    city: "location",
    language: "language",
    country: "country",
    country_code: "country",
    "country code": "country",
    tags: "tags",
    tag: "tags",
    stage: "stage",
    stage_name: "stage",
    "stage name": "stage",
  };
  const hit = builtin[h];
  if (hit && BUILTIN_VALUES.has(hit)) return hit;
  // Custom field labels match case-insensitively on their exact label.
  const custom = options.find(
    (o) => !BUILTIN_VALUES.has(o.value) && o.value.toLowerCase() === h,
  );
  return custom ? custom.value : IGNORE;
}
