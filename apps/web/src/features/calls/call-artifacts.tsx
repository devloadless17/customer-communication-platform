"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { BROWSER_API_BASE } from "@/lib/api/browser-base";

/**
 * Shared renderers for a call's stored artifacts — the recording player and
 * the transcript panel — used by BOTH the Calls page rows and the inbox
 * thread's call bubble, so the two surfaces can never drift.
 *
 * Nothing is fetched until the surface mounts one of these (the caller shows
 * them on demand); the transcript renders every text node with `dir="auto"`
 * so Arabic — the auto-detected language for most of this platform's calls —
 * lays out right-to-left correctly.
 */

export function RecordingPlayer({ callId }: { callId: string }) {
  return (
    // Streamed same-origin with Range support, so seeking works.
    <audio
      controls
      autoPlay
      preload="none"
      // Dev crosses :3000 → :4000, so the session cookie needs credentialed
      // CORS; prod is same-origin and unaffected.
      crossOrigin="use-credentials"
      src={`${BROWSER_API_BASE}/api/calls/${callId}/recording`}
      className="h-9 w-full max-w-md"
    >
      <track kind="captions" />
    </audio>
  );
}

interface TranscriptSegment {
  id?: number;
  speaker?: string;
  start?: number;
  text?: string;
}

interface TranscriptDoc {
  transcript?: {
    text?: string;
    language?: string;
    segments?: TranscriptSegment[];
  };
}

function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TranscriptPanel({ callId }: { callId: string }) {
  const [state, setState] = useState<"loading" | "error" | "ready">("loading");
  const [doc, setDoc] = useState<TranscriptDoc | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/calls/${callId}/transcript`);
        if (!res.ok) throw new Error(`transcript ${res.status}`);
        const json = (await res.json()) as TranscriptDoc;
        if (!cancelled) {
          setDoc(json);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [callId]);

  if (state === "loading") {
    return (
      <p className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Loading transcript…
      </p>
    );
  }
  if (state === "error") {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        Couldn&apos;t load the transcript. Try again in a moment.
      </p>
    );
  }
  const segments = doc?.transcript?.segments ?? [];
  if (segments.length === 0) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        The transcript is empty — the call may have had no clear speech, or was
        in a language WhatsApp can&apos;t transcribe yet.
      </p>
    );
  }
  return (
    <div className="my-1 flex max-h-72 flex-col gap-1.5 overflow-y-auto rounded-md border bg-muted/30 p-3">
      {segments.map((s, i) => (
        <div key={s.id ?? i} className="flex flex-col">
          <span className="text-2xs font-medium text-muted-foreground">
            {s.speaker === "Business" ? "Agent" : "Customer"}
            {typeof s.start === "number" && (
              <span className="ml-1 tabular-nums opacity-60">
                {formatSeconds(Math.floor(s.start))}
              </span>
            )}
          </span>
          <p dir="auto" className="text-sm leading-snug">
            {s.text ?? ""}
          </p>
        </div>
      ))}
    </div>
  );
}
