"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

/**
 * Persisted AI draft, rendered directly ABOVE the composer (placement map §5).
 * Survives refresh/reconnect because it lives server-side (AiReplySuggestion).
 * Actions: Edit (inline), Send, Reject, Take over. Shows an expandable
 * "Used N company knowledge sources" line (chunk count only — never the chunks).
 */

interface Suggestion {
  id: string;
  text: string;
  channelMode: string;
  usedChunkIds: string[];
}

export function AiSuggestionBar({ conversationId }: { conversationId: string }) {
  const [sugg, setSugg] = useState<Suggestion | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSources, setShowSources] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/ai-assistant/conversations/${conversationId}/overview`);
    if (!res.ok) return;
    const data = (await res.json()) as { suggestion?: Suggestion | null };
    setSugg(data.suggestion ?? null);
    setText(data.suggestion?.text ?? "");
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!sugg) return null;

  const edited = text.trim() !== sugg.text.trim();
  const sourceCount = sugg.usedChunkIds?.length ?? 0;
  const isVoice = sugg.channelMode === "voice" || sugg.channelMode === "text_and_voice";

  async function decide(action: "accept" | "reject") {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/ai-assistant/suggestions/${sugg!.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(action === "accept" && edited ? { editedText: text } : {}) }),
      });
      if (!res.ok) {
        toast.error(action === "accept" ? "Send failed" : "Failed");
        return;
      }
      setSugg(null);
      if (action === "accept") toast.success("Sent");
    } finally {
      setBusy(false);
    }
  }

  async function takeOver() {
    setBusy(true);
    try {
      await apiFetch(`/api/ai-assistant/conversations/${conversationId}/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "takeover" }),
      });
      await apiFetch(`/api/ai-assistant/suggestions/${sugg!.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      });
      setSugg(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-3 mb-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-primary">
          AI suggested reply{isVoice ? " (voice)" : ""}
        </span>
        {sourceCount > 0 && (
          <button
            className="text-xs text-muted-foreground hover:underline"
            onClick={() => setShowSources((s) => !s)}
          >
            Used {sourceCount} company knowledge source{sourceCount === 1 ? "" : "s"}
          </button>
        )}
      </div>
      {showSources && (
        <p className="mb-1.5 text-xs text-muted-foreground">
          {sourceCount} knowledge chunk(s) were used to ground this reply. (Sources are never shown
          to the customer.)
        </p>
      )}
      <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} className="mb-2" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => void decide("accept")}>
          {edited ? "Edit & Send" : "Send"}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load()}>
          Reset
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("reject")}>
          Reject
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void takeOver()}>
          Take over
        </Button>
        {isVoice && (
          <span className="text-xs text-muted-foreground">
            voice delivery falls back to text
          </span>
        )}
      </div>
    </div>
  );
}
