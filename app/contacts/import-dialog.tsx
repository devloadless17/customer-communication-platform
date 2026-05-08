"use client";

import { useEffect, useRef, useState } from "react";
import { FileUp, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Modal for importing contacts from a CSV. Drives a single multipart POST to
 * /api/contacts/import. The backend dedupes on phone number — existing rows
 * are left untouched, only new ones are appended — so re-uploading the same
 * file twice is safe.
 *
 * After a successful import, the parent reloads the page so the new rows and
 * any field-definition changes (which the backend doesn't currently make on
 * its own — we only match against existing defs) are reflected.
 */
export function ImportContactsDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!file) return;
    setError(null);
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        body: form,
      });
      const body = (await res.json().catch(() => ({}))) as
        | ImportResult
        | { error?: string };
      if (!res.ok) {
        setError(("error" in body && body.error) || "Import failed");
        return;
      }
      setResult(body as ImportResult);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    if (result) onImported();
    else onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-contacts-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-16"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card text-card-foreground shadow-lg">
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

        {!result ? (
          <div className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">
              Upload a CSV with a <code className="rounded bg-muted px-1">phone_number</code>{" "}
              column. Existing contacts are matched by phone number and left untouched —
              only new rows are added.
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-background px-4 py-8 text-sm hover:bg-accent hover:text-foreground"
            >
              <FileUp className="size-4" />
              {file ? file.name : "Choose a .csv file"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setError(null);
              }}
            />

            {error && (
              <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
                Cancel
              </Button>
              <Button type="button" onClick={submit} disabled={!file || submitting}>
                {submitting && <Loader2 className="size-3.5 animate-spin" />}
                Import
              </Button>
            </div>
          </div>
        ) : (
          <ImportResultView result={result} onClose={close} />
        )}
      </div>
    </div>
  );
}

interface ImportResult {
  total: number;
  created: number;
  skippedExisting: number;
  errors: Array<{ row: number; reason: string }>;
  unknownColumns: string[];
}

function ImportResultView({
  result,
  onClose,
}: {
  result: ImportResult;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3 p-4">
      <div className="rounded-md border border-border bg-background p-3 text-sm">
        <div className="font-medium">
          Imported {result.created} new contact{result.created === 1 ? "" : "s"}.
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {result.skippedExisting > 0 && (
            <div>
              Skipped {result.skippedExisting} that already existed (matched by phone
              number).
            </div>
          )}
          <div>
            Processed {result.total} row{result.total === 1 ? "" : "s"} total.
          </div>
        </div>
      </div>

      {result.unknownColumns.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <div className="font-medium text-amber-700 dark:text-amber-400">
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

      {result.errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
          <div className="font-medium text-destructive">
            {result.errors.length} row{result.errors.length === 1 ? "" : "s"} couldn't be
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
