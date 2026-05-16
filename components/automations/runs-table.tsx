"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, RefreshCw, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Runs table. Fetches on mount + manual refresh — no live updates yet (runs
 * fire async via BullMQ; a socket event for run-completed is a fast follow-up
 * if the polling feels janky in practice).
 */

interface Run {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "skipped";
  trigger: string;
  attempts: number;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function RunsTable({ automationId }: { automationId: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/team/automations/${automationId}/runs`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as { runs: Run[] };
      setRuns(json.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId]);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        Couldn't load runs: {error}
      </div>
    );
  }

  if (runs === null) {
    return <div className="text-xs text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw className={"size-3.5 " + (loading ? "animate-spin" : "")} />
          Refresh
        </Button>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          No runs yet. Click <span className="font-mono">Test</span> above or wait
          for a real trigger.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {runs.map((r) => {
            const open = expanded[r.id];
            return (
              <div key={r.id}>
                <button
                  type="button"
                  onClick={() => setExpanded((p) => ({ ...p, [r.id]: !open }))}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
                >
                  {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                  <StatusBadge status={r.status} />
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {r.responseStatus ?? "—"}
                  </span>
                  <span className="text-xs">
                    attempt {r.attempts}
                  </span>
                  <span className="ml-auto text-[11px] text-muted-foreground" suppressHydrationWarning>
                    {new Date(r.startedAt).toLocaleString()}
                  </span>
                </button>
                {open && (
                  <div className="border-t border-border bg-muted/20 px-3 py-2 text-xs">
                    {r.errorMessage && (
                      <div>
                        <div className="font-medium text-destructive">Error</div>
                        <pre className="mt-1 whitespace-pre-wrap text-destructive">{r.errorMessage}</pre>
                      </div>
                    )}
                    {r.responseBody && (
                      <div className="mt-2">
                        <div className="font-medium text-muted-foreground">Response body</div>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-[11px]">
                          {r.responseBody}
                        </pre>
                      </div>
                    )}
                    {!r.errorMessage && !r.responseBody && (
                      <div className="text-muted-foreground">No body or error captured.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Run["status"] }) {
  const map: Record<Run["status"], { label: string; cls: string; Icon?: typeof CheckCircle2 }> = {
    success: { label: "success", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", Icon: CheckCircle2 },
    failed: { label: "failed", cls: "bg-destructive/15 text-destructive", Icon: XCircle },
    queued: { label: "queued", cls: "bg-muted text-muted-foreground" },
    running: { label: "running", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
    skipped: { label: "skipped", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[status];
  const Icon = m.Icon;
  return (
    <span className={"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide " + m.cls}>
      {Icon && <Icon className="size-3" />}
      {m.label}
    </span>
  );
}
