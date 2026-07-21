"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";

import {
  IMPORT_EVENT_FANOUT_CAP,
  TRANSFER_MAX_UPLOAD_BYTES,
} from "@ccp/shared/contacts/transfer-columns";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client-fetch";

import { TransferProgress } from "./transfer-progress";
import { useTransferJob } from "./use-transfer-job";

/**
 * Import wizard: file → map columns → options → run.
 *
 * The file is uploaded once, on step 1, and PARSED SERVER-SIDE. The previous
 * dialog parsed CSV in the browser and rebuilt a canonical file before
 * uploading, which meant a second CSV implementation to keep in sync with the
 * server's and no path to supporting Excel at all. Now the server returns the
 * headers, a sample, and its suggested mapping — the browser only renders them.
 */

interface Preview {
  headers: string[];
  sampleRows: Array<Record<string, string>>;
  suggestedMapping: Record<string, string>;
  fields: Array<{ key: string; label: string }>;
  builtins: Array<{ id: string; label: string }>;
  uploadKey: string;
  filename: string;
  format: "csv" | "xlsx";
}

type Step = "file" | "map" | "options" | "run";

export function ImportContactsWizard({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [step, setStep] = useState<Step>("file");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mode, setMode] = useState("create_only");
  const [tagMode, setTagMode] = useState("merge");
  const [fireAutomations, setFireAutomations] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const notifiedRef = useRef(false);

  const { job, cancel } = useTransferJob(jobId);

  // Refresh the contacts list exactly once, when the job first reaches a state
  // where rows actually changed. Firing on every progress frame would refetch
  // the list dozens of times during a long import.
  if (job && job.status === "completed" && !notifiedRef.current) {
    notifiedRef.current = true;
    onImported();
  }

  const phoneMapped = useMemo(
    () => Object.values(mapping).includes("phone_number"),
    [mapping],
  );

  const upload = useCallback(async (file: File) => {
    setError(null);
    if (file.size > TRANSFER_MAX_UPLOAD_BYTES) {
      setError(
        `That file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${Math.round(
          TRANSFER_MAX_UPLOAD_BYTES / 1048576,
        )} MB.`,
      );
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await apiFetch("/api/contacts/import/preview", { method: "POST", body });
      const json = (await res.json()) as Preview & { error?: string; detail?: string };
      if (!res.ok) {
        setError(json.detail ?? json.error ?? "We couldn't read that file.");
        return;
      }
      setPreview(json);
      setMapping(json.suggestedMapping);
      setStep("map");
    } catch {
      setError("We couldn't upload that file. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/contacts/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uploadKey: preview.uploadKey,
          filename: preview.filename,
          format: preview.format,
          options: { mode, tagMode, fireAutomations, mapping },
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string; detail?: string };
      if (!res.ok || !json.jobId) {
        setError(json.detail ?? json.error ?? "We couldn't start the import.");
        return;
      }
      setJobId(json.jobId);
      setStep("run");
    } finally {
      setBusy(false);
    }
  }, [preview, mode, tagMode, fireAutomations, mapping]);

  const done = job ? ["completed", "failed", "canceled"].includes(job.status) : false;

  return (
    <Dialog open onClose={onClose}>
      <DialogContent className="max-w-2xl" labelledBy="import-contacts-title">
        <div className="border-b border-border px-4 py-3">
          <h2 id="import-contacts-title" className="text-base font-semibold">
            Import contacts
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {step === "file" && "Upload a CSV or Excel file. Contacts are matched by phone number."}
            {step === "map" && "Check which column goes where. We've guessed based on your headers."}
            {step === "options" && "Decide what happens to contacts that already exist."}
            {step === "run" && preview?.filename}
          </p>
        </div>
        <div className="space-y-4 px-4 py-4">

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {step === "file" && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-sm transition-colors hover:border-primary hover:bg-muted/50 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              ) : (
                <Upload className="size-6 text-muted-foreground" />
              )}
              <span className="font-medium">
                {busy ? "Reading your file…" : "Choose a CSV or Excel file"}
              </span>
              <span className="text-xs text-muted-foreground">
                .csv or .xlsx, up to {Math.round(TRANSFER_MAX_UPLOAD_BYTES / 1048576)} MB
              </span>
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Reset so re-picking the SAME file after an error still fires
                // a change event.
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
            <div className="flex items-center justify-center gap-3 text-xs">
              <a
                className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:underline"
                href="/api/contacts/transfer-template?format=csv"
                download
              >
                <Download className="size-3.5" />
                CSV template
              </a>
              <a
                className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:underline"
                href="/api/contacts/transfer-template?format=xlsx"
                download
              >
                <FileSpreadsheet className="size-3.5" />
                Excel template
              </a>
            </div>
          </div>
        )}

        {step === "map" && preview && (
          <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
            {preview.headers.map((header) => {
              const sample = preview.sampleRows.find((r) => r[header])?.[header];
              return (
                <div
                  key={header}
                  className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{header}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {sample ? `e.g. ${sample}` : "no values in the first rows"}
                    </p>
                  </div>
                  <Select
                    aria-label={`Import "${header}" as`}
                    wrapperClassName="w-52"
                    value={mapping[header] ?? "ignore"}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [header]: e.target.value }))
                    }
                  >
                    <option value="ignore">Don&apos;t import</option>
                    {preview.builtins.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                    {preview.fields.map((f) => (
                      <option key={f.key} value={`field:${f.key}`}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}
          </div>
        )}

        {step === "options" && (
          <div className="space-y-5">
            <Field
              label="Contacts that already exist"
              hint="Matched on phone number."
            >
              <Select
                aria-label="What to do with contacts that already exist"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="create_only">Skip them — only add new contacts</option>
                <option value="create_and_update">Update them, and add new contacts</option>
                <option value="update_only">
                  Only update them — don&apos;t add anyone new
                </option>
              </Select>
              {mode !== "create_only" && (
                <p className="text-xs text-muted-foreground">
                  Empty cells are left alone — a blank column never erases an existing
                  value.
                </p>
              )}
            </Field>

            <Field label="Tags">
              <Select
                aria-label="How to apply tags"
                value={tagMode}
                onChange={(e) => setTagMode(e.target.value)}
              >
                <option value="merge">Add to existing tags</option>
                <option value="replace">Replace existing tags</option>
              </Select>
            </Field>

            <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Trigger automations</p>
                <p className="text-xs text-muted-foreground">
                  Run workflows and send webhooks for each imported contact. Turned off
                  automatically for imports over{" "}
                  {IMPORT_EVENT_FANOUT_CAP.toLocaleString()} rows.
                </p>
              </div>
              <Switch checked={fireAutomations} onCheckedChange={setFireAutomations} />
            </div>
          </div>
        )}

        {step === "run" && <TransferProgress job={job} onCancel={cancel} />}

        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
          {step === "map" && !phoneMapped ? (
            <p className="text-xs text-destructive">
              Map one column to the phone number to continue.
            </p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {step === "map" && (
              <>
                <Button variant="ghost" onClick={() => setStep("file")}>
                  Back
                </Button>
                <Button disabled={!phoneMapped} onClick={() => setStep("options")}>
                  Next
                </Button>
              </>
            )}
            {step === "options" && (
              <>
                <Button variant="ghost" onClick={() => setStep("map")}>
                  Back
                </Button>
                <Button disabled={busy} onClick={() => void start()}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  Import
                </Button>
              </>
            )}
            {step === "run" && (
              <Button variant={done ? "default" : "ghost"} onClick={onClose}>
                {done ? "Done" : "Close"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}
