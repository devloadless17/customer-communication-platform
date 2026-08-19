"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessageFrom } from "@ccp/shared/api/error-message";

import { TransferProgress } from "./transfer-progress";
import { useTransferJob } from "./use-transfer-job";

/** Filters the contacts list is currently showing, forwarded to the export. */
export interface ExportFilters {
  search?: string;
  fieldKey?: string;
  fieldValue?: string;
  fieldMode?: "contains" | "equals";
  source?: string;
  channel?: string;
  reach?: "phone" | "email";
  window?: "open" | "closed";
  stageId?: string;
  tagIds?: string[];
}

type Scope = "filtered" | "selected" | "all";

/**
 * Export dialog: pick a format and what to include, then watch it build and
 * download automatically.
 *
 * "What to include" is the reason this dialog exists at all — the old export
 * was a link that always dumped every contact, ignoring whatever the user had
 * filtered or ticked on screen.
 */
export function ExportContactsDialog({
  onClose,
  filters,
  selectedIds,
  filteredCount,
}: {
  onClose: () => void;
  filters: ExportFilters;
  selectedIds: string[];
  /** Rows matching the active filters — the list's own live total. */
  filteredCount: number;
}) {
  const hasFilters = Object.values(filters).some((v) =>
    Array.isArray(v) ? v.length > 0 : Boolean(v),
  );
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [scope, setScope] = useState<Scope>(
    selectedIds.length > 0 ? "selected" : hasFilters ? "filtered" : "all",
  );
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const downloadedRef = useRef(false);
  // The whole-directory total, which the LIST doesn't know: `filteredCount` is
  // the count for the active filters, so showing it for both options would
  // label two different scopes with the same number.
  const [directoryTotal, setDirectoryTotal] = useState<number | null>(null);

  const { job, cancel } = useTransferJob(jobId);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/contacts/count-all");
        if (!res.ok || !alive) return;
        const { count } = (await res.json()) as { count: number };
        setDirectoryTotal(count);
      } catch {
        // Non-fatal — the option just renders without a count.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Auto-start the download the moment the artifact exists. The user asked for
  // a file; making them click a second button after waiting is friction with no
  // purpose. The panel still shows the link for a re-download.
  useEffect(() => {
    if (job?.status === "completed" && job.hasArtifact && !downloadedRef.current) {
      downloadedRef.current = true;
      window.location.href = `/api/contacts/transfers/${job.id}/download`;
    }
  }, [job]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/contacts/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format,
          ...(scope === "selected" ? { ids: selectedIds } : {}),
          ...(scope === "filtered" ? { filters } : {}),
        }),
      });
      const json = (await res.json()) as { jobId?: string; error?: string; detail?: string };
      if (!res.ok || !json.jobId) {
        setError(apiErrorMessageFrom(json, "We couldn't start the export."));
        return;
      }
      setJobId(json.jobId);
    } finally {
      setBusy(false);
    }
  }, [format, scope, selectedIds, filters]);

  const done = job ? ["completed", "failed", "canceled"].includes(job.status) : false;

  return (
    <Dialog open onClose={onClose}>
      <DialogContent className="max-w-md" labelledBy="export-contacts-title">
        <div className="border-b border-border px-4 py-3">
          <h2 id="export-contacts-title" className="text-base font-semibold">
            Export contacts
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {jobId
              ? "Your download will start automatically."
              : "Choose a format and what to include."}
          </p>
        </div>
        <div className="space-y-4 px-4 py-4">

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {!jobId ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Format</p>
              <Select
                aria-label="Export format"
                value={format}
                onChange={(e) => setFormat(e.target.value as "csv" | "xlsx")}
              >
                <option value="csv">CSV</option>
                <option value="xlsx">Excel (.xlsx)</option>
              </Select>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium">Include</p>
              <Select
                aria-label="Contacts to include"
                value={scope}
                onChange={(e) => setScope(e.target.value as Scope)}
              >
                {selectedIds.length > 0 && (
                  <option value="selected">
                    Selected ({selectedIds.length.toLocaleString()})
                  </option>
                )}
                {hasFilters && (
                  <option value="filtered">
                    Current filters ({filteredCount.toLocaleString()})
                  </option>
                )}
                <option value="all">
                  All contacts
                  {directoryTotal !== null ? ` (${directoryTotal.toLocaleString()})` : ""}
                </option>
              </Select>
            </div>
          </div>
        ) : (
          <TransferProgress job={job} onCancel={cancel} />
        )}

        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          {!jobId ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void start()}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                Export
              </Button>
            </>
          ) : (
            <Button variant={done ? "default" : "ghost"} onClick={onClose}>
              {done ? "Done" : "Close"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
