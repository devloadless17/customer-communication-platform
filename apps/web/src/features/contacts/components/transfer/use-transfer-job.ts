"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getClientSocket } from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";

/** Wire shape of a transfer job, mirroring the server's `toWire`. */
export interface TransferJob {
  id: string;
  kind: "import" | "export";
  format: "csv" | "xlsx";
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  filename: string;
  processedRows: number;
  totalRows: number | null;
  created: number;
  updated: number;
  revived: number;
  skipped: number;
  failed: number;
  automationsSkipped: boolean;
  hasArtifact: boolean;
  artifactBytes?: number | null;
  hasErrorReport: boolean;
  error: string | null;
  details?: {
    errors?: Array<{ row: number; reason: string }>;
    unknownColumns?: string[];
    unknownStages?: string[];
    extraSheets?: string[];
  };
}

const TERMINAL = new Set(["completed", "failed", "canceled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/**
 * Track one transfer job to completion.
 *
 * Primary signal is the `contacts:transfer_progress` socket frame, scoped to
 * this user's room. A slow poll runs alongside it as a safety net: the frames
 * are the fast path, but a socket flap during a 3-minute import must not leave
 * the user staring at a bar frozen at 40%. The poll is deliberately lazy (4s)
 * because it exists only to recover, not to drive the UI.
 */
export function useTransferJob(jobId: string | null): {
  job: TransferJob | null;
  cancel: () => Promise<void>;
} {
  const [job, setJob] = useState<TransferJob | null>(null);
  // Read inside the interval without making it a dependency, so the poll isn't
  // torn down and rebuilt on every progress frame.
  const statusRef = useRef<string | null>(null);
  statusRef.current = job?.status ?? null;

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }
    let alive = true;

    const socket = getClientSocket();
    const onProgress = (payload: { job: TransferJob }) => {
      if (!alive || payload.job.id !== jobId) return;
      setJob(payload.job);
    };
    socket.on("contacts:transfer_progress", onProgress);

    const fetchOnce = async () => {
      try {
        const res = await apiFetch(`/api/contacts/transfers/${jobId}`);
        if (!res.ok || !alive) return;
        setJob((await res.json()) as TransferJob);
      } catch {
        // Transient — the socket or the next tick recovers.
      }
    };
    // Seed immediately: a job that finished before the socket listener attached
    // (a tiny export completes in well under a second) would otherwise never
    // produce a frame we'd see.
    void fetchOnce();

    const timer = setInterval(() => {
      if (statusRef.current && isTerminal(statusRef.current)) return;
      void fetchOnce();
    }, 4000);

    return () => {
      alive = false;
      socket.off("contacts:transfer_progress", onProgress);
      clearInterval(timer);
    };
  }, [jobId]);

  const cancel = useCallback(async () => {
    if (!jobId) return;
    await apiFetch(`/api/contacts/transfers/${jobId}/cancel`, { method: "POST" }).catch(
      () => {},
    );
  }, [jobId]);

  return { job, cancel };
}

/** Percentage for the progress bar, or null when the total isn't known yet. */
export function progressPercent(job: TransferJob | null): number | null {
  if (!job || !job.totalRows || job.totalRows <= 0) return null;
  return Math.min(100, Math.round((job.processedRows / job.totalRows) * 100));
}
