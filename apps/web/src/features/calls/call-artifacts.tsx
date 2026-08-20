"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { BROWSER_API_BASE } from "@/lib/api/browser-base";
import { playableAudioUrl } from "@/lib/audio-compat";

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
      // Recordings are archived as ogg/opus, which Safari can't decode
      // before 18.4 — the helper swaps in the API's AAC variant there.
      src={playableAudioUrl(`${BROWSER_API_BASE}/api/calls/${callId}/recording`, "audio/ogg")}
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
  const flatText = doc?.transcript?.text?.trim();
  if (segments.length === 0) {
    // In-app transcripts (our Whisper pipeline) carry the conversation as one
    // text block without per-speaker segments — render it rather than calling
    // a perfectly good transcript "empty".
    if (flatText) {
      return (
        <div className="my-1 max-h-72 overflow-y-auto rounded-md border bg-muted/30 p-3">
          <p dir="auto" className="whitespace-pre-wrap text-sm leading-snug">
            {flatText}
          </p>
        </div>
      );
    }
    return (
      <p className="py-2 text-xs text-muted-foreground">
        The transcript is empty — the call may have had no clear speech, or was
        in a language that couldn&apos;t be transcribed.
      </p>
    );
  }
  // Speaker-attributed turns. The agent's side is tinted and the customer's is
  // neutral so the two are separable at a glance without reading the labels —
  // which matters most in Arabic, where the text itself flips direction and a
  // label-only distinction is easy to lose.
  return (
    <div className="my-1 flex max-h-72 flex-col gap-2.5 overflow-y-auto rounded-md border bg-muted/30 p-3">
      {segments.map((s, i) => {
        const isAgent = s.speaker === "Business";
        return (
          <div
            key={s.id ?? i}
            className={
              "flex flex-col gap-0.5 border-s-2 ps-2 " +
              (isAgent ? "border-primary/40" : "border-border")
            }
          >
            <span className="flex items-center gap-1.5 text-2xs font-medium">
              <span className={isAgent ? "text-primary" : "text-muted-foreground"}>
                {isAgent ? "Agent" : "Customer"}
              </span>
              {typeof s.start === "number" && (
                <span className="tabular-nums text-muted-foreground opacity-60">
                  {formatSeconds(Math.floor(s.start))}
                </span>
              )}
            </span>
            <p dir="auto" className="text-sm leading-snug">
              {s.text ?? ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}
