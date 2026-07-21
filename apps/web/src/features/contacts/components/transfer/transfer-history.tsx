"use client";

import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Download, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { LocalTime } from "@/components/local-time";
import { apiFetch } from "@/lib/api/client-fetch";

import type { TransferJob } from "./use-transfer-job";

/**
 * Recent import/export jobs with their outcome and download links.
 *
 * Exists because a transfer outlives the dialog that started it: an agent can
 * close the wizard, navigate away, and come back — and a 100k export they
 * queued before lunch should still be one click away rather than something
 * they have to run again.
 */
export function TransferHistorySheet({ onClose }: { onClose: () => void }) {
  const [jobs, setJobs] = useState<TransferJob[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/contacts/transfers?limit=20");
        if (!res.ok || !alive) return;
        const json = (await res.json()) as { jobs: Array<TransferJob & { createdAt: string }> };
        setJobs(json.jobs);
      } catch {
        if (alive) setJobs([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      side="right"
      contentClassName="w-full max-w-105"
      labelledBy="transfer-history-title"
    >
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-4 py-3">
          <h2 id="transfer-history-title" className="text-base font-semibold">
            Imports &amp; exports
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Files are kept for 7 days, then deleted.
          </p>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {jobs === null && (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </p>
          )}
          {jobs?.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">
              Nothing here yet. Imports and exports you run will show up on this list.
            </p>
          )}
          {jobs?.map((job) => (
            <div key={job.id} className="rounded-lg border px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {job.kind === "import" ? (
                      <ArrowUpFromLine className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ArrowDownToLine className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{job.filename}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <LocalTime
                      iso={(job as TransferJob & { createdAt: string }).createdAt}
                      format="localeString"
                    />
                    {job.kind === "import" && job.status === "completed" && (
                      <>
                        {" · "}
                        {job.created.toLocaleString()} added, {job.updated.toLocaleString()}{" "}
                        updated
                        {job.failed > 0 && `, ${job.failed.toLocaleString()} failed`}
                      </>
                    )}
                    {job.kind === "export" && job.status === "completed" && (
                      <> · {job.processedRows.toLocaleString()} contacts</>
                    )}
                  </p>
                </div>
                <StatusBadge status={job.status} />
              </div>

              {(job.hasArtifact || job.hasErrorReport) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {job.hasArtifact && (
                    <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                      <a href={`/api/contacts/transfers/${job.id}/download`} download>
                        <Download className="size-3.5" />
                        Download
                      </a>
                    </Button>
                  )}
                  {job.hasErrorReport && (
                    <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                      <a href={`/api/contacts/transfers/${job.id}/errors`} download>
                        <Download className="size-3.5" />
                        Failed rows
                      </a>
                    </Button>
                  )}
                </div>
              )}

              {job.status === "failed" && job.error && (
                <p className="mt-1.5 text-xs text-destructive">{job.error}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function StatusBadge({ status }: { status: TransferJob["status"] }) {
  if (status === "completed") return <Badge variant="secondary">Done</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "canceled") return <Badge variant="outline">Canceled</Badge>;
  return (
    <Badge variant="outline" className="gap-1">
      <Loader2 className="size-3 animate-spin" />
      Running
    </Badge>
  );
}
