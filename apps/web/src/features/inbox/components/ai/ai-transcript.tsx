"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api/client-fetch";

/**
 * Voice-note transcript, rendered directly BELOW an inbound voice bubble
 * (placement map §6). Show/hide + inline correction. Renders nothing until a
 * ready transcript exists for the message.
 */

interface Transcription {
  status: "pending" | "ready" | "failed";
  transcript: string | null;
  correctedText: string | null;
}

export function AiTranscript({ messageId }: { messageId: string }) {
  const [t, setT] = useState<Transcription | null>(null);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await apiFetch(`/api/ai-assistant/transcriptions/${messageId}`);
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as { transcription: Transcription | null };
      if (!cancelled) setT(data.transcription);
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  if (!t || t.status !== "ready") return null;
  const text = t.correctedText || t.transcript || "";
  if (!text) return null;

  async function save() {
    const res = await apiFetch(`/api/ai-assistant/transcriptions/${messageId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correctedText: draft }),
    });
    if (res.ok) {
      setT((prev) => (prev ? { ...prev, correctedText: draft } : prev));
      setEditing(false);
    }
  }

  return (
    <div className="mt-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="font-medium">Transcript</span>
        <button className="hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? "hide" : "show"}
        </button>
        {open && !editing && (
          <button
            className="hover:underline"
            onClick={() => {
              setDraft(text);
              setEditing(true);
            }}
          >
            correct
          </button>
        )}
      </div>
      {open &&
        (editing ? (
          <div className="mt-1 space-y-1">
            <textarea
              className="w-full rounded border border-border bg-background p-1 text-xs"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="text-primary hover:underline" onClick={() => void save()}>
                save
              </button>
              <button className="text-muted-foreground hover:underline" onClick={() => setEditing(false)}>
                cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 text-foreground">{text}</p>
        ))}
    </div>
  );
}
