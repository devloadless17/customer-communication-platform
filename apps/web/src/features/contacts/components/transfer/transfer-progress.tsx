"use client";

import { AlertTriangle, CheckCircle2, Download, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

import { progressPercent, type TransferJob } from "./use-transfer-job";

/**
 * Shared progress + result panel for an import or export job. Both flows end
 * the same way — a bar, then counters and a download — so they share one
 * component rather than two that drift.
 */
export function TransferProgress({
  job,
  onCancel,
}: {
  job: TransferJob | null;
  onCancel?: () => void;
}) {
  if (!job) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Starting…
      </div>
    );
  }

  const pct = progressPercent(job);
  const running = job.status === "pending" || job.status === "running";

  return (
    <div className="space-y-4 py-2">
      {running && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {job.kind === "export" ? "Preparing your file…" : "Importing…"}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {job.totalRows
                ? `${job.processedRows.toLocaleString()} / ${job.totalRows.toLocaleString()}`
                : job.processedRows.toLocaleString()}
            </span>
          </div>
          {/* Indeterminate until the total is counted, so the bar never
              pretends to know a percentage it doesn't. */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={
                pct === null
                  ? "h-full w-1/3 animate-pulse rounded-full bg-primary/60"
                  : "h-full rounded-full bg-primary transition-[width] duration-500"
              }
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            You can close this — it keeps running and you&apos;ll find it under Transfers.
          </p>
        </div>
      )}

      {job.status === "completed" && (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="size-4 text-emerald-600" />
            {job.kind === "export" ? "Your file is ready." : "Import finished."}
          </p>

          {job.kind === "import" && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <Stat label="Added" value={job.created} />
              <Stat label="Updated" value={job.updated} />
              <Stat label="Restored" value={job.revived} />
              <Stat label="Skipped" value={job.skipped} />
              {job.failed > 0 && <Stat label="Failed" value={job.failed} tone="danger" />}
            </dl>
          )}

          {job.automationsSkipped && (
            <Callout>
              This import was larger than 5,000 rows, so automations and webhooks were
              not triggered for the imported contacts. The contacts themselves imported
              normally.
            </Callout>
          )}

          {job.details?.unknownColumns && job.details.unknownColumns.length > 0 && (
            <Callout>
              These columns weren&apos;t recognised and were ignored:{" "}
              <span className="font-medium">{job.details.unknownColumns.join(", ")}</span>.
              Add them as contact fields first if you need them.
            </Callout>
          )}

          {job.details?.unknownStages && job.details.unknownStages.length > 0 && (
            <Callout>
              These stages don&apos;t exist, so those contacts went to your default stage:{" "}
              <span className="font-medium">{job.details.unknownStages.join(", ")}</span>.
            </Callout>
          )}

          {job.details?.extraSheets && job.details.extraSheets.length > 0 && (
            <Callout>
              Only the first sheet was imported. Ignored:{" "}
              <span className="font-medium">{job.details.extraSheets.join(", ")}</span>.
            </Callout>
          )}

          <div className="flex flex-wrap gap-2">
            {job.hasArtifact && (
              <Button asChild size="sm">
                {/* Plain anchor so the browser handles the download; the route
                    redirects to a short-lived presigned URL. */}
                <a href={`/api/contacts/transfers/${job.id}/download`} download>
                  <Download className="size-4" />
                  Download
                </a>
              </Button>
            )}
            {job.hasErrorReport && (
              <Button asChild size="sm" variant="outline">
                <a href={`/api/contacts/transfers/${job.id}/errors`} download>
                  <Download className="size-4" />
                  Download {job.failed.toLocaleString()} failed row
                  {job.failed === 1 ? "" : "s"}
                </a>
              </Button>
            )}
          </div>
          {job.hasErrorReport && (
            <p className="text-xs text-muted-foreground">
              The failed-rows file has your original columns plus why each row was
              rejected — fix them there and import that file again.
            </p>
          )}
        </div>
      )}

      {job.status === "failed" && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          {job.error ?? "The transfer failed."}
        </p>
      )}

      {job.status === "canceled" && (
        <p className="text-sm text-muted-foreground">
          Canceled.
          {job.kind === "import" && job.created + job.updated > 0 && (
            <>
              {" "}
              {(job.created + job.updated).toLocaleString()} contacts had already been
              imported and were kept.
            </>
          )}
        </p>
      )}

      {running && onCancel && (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger";
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`tabular-nums font-medium ${tone === "danger" ? "text-destructive" : ""}`}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
