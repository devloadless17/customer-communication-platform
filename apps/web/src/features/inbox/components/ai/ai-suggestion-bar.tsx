"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api/client-fetch";
import { BROWSER_API_BASE } from "@/lib/api/browser-base";
import { getClientSocket } from "@/lib/socket-client";
import { toast } from "@/lib/toast";

/**
 * Persisted AI draft, rendered directly ABOVE the composer (placement map §5).
 * Survives refresh/reconnect (server-persisted). Actions: Edit, Send (text),
 * Send as Voice / Send as Text (voice modes), Regenerate, Reject, Take over.
 * Voice drafts show an audio preview of the pre-rendered TTS.
 */

interface Suggestion {
  id: string;
  text: string;
  channelMode: string;
  usedChunkIds: string[];
  audioR2Key?: string | null;
  attempt?: number;
}

const VOICE_MODES = new Set(["voice", "text_and_voice", "match_customer"]);

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

  // Realtime: a new/updated/resolved draft (ai.suggestion_changed).
  useEffect(() => {
    const socket = getClientSocket();
    const onSuggestion = (p: {
      teamId: string;
      conversationId: string;
      suggestionId: string | null;
      state: string;
    }) => {
      if (p.conversationId === conversationId) void load();
    };
    socket.on("ai:suggestion", onSuggestion);
    return () => {
      socket.off("ai:suggestion", onSuggestion);
    };
  }, [conversationId, load]);

  if (!sugg) return null;

  const edited = text.trim() !== sugg.text.trim();
  const sourceCount = sugg.usedChunkIds?.length ?? 0;
  const isVoice = VOICE_MODES.has(sugg.channelMode);
  const hasAudio = isVoice && !!sugg.audioR2Key;

  async function decide(action: "accept" | "reject", sendAs?: "text" | "voice") {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/ai-assistant/suggestions/${sugg!.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "accept" && edited ? { editedText: text } : {}),
          ...(sendAs ? { sendAs } : {}),
        }),
      });
      if (!res.ok) {
        toast.error(action === "accept" ? "Send failed" : "Failed");
        return;
      }
      setSugg(null);
      if (action === "accept") toast.success(sendAs === "voice" ? "Sent as voice" : "Sent");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/ai-assistant/suggestions/${sugg!.id}/regenerate`, {
        method: "POST",
      });
      if (!res.ok) {
        toast.error("Regenerate failed");
        return;
      }
      const data = (await res.json()) as { suggestion: Suggestion };
      setSugg(data.suggestion);
      setText(data.suggestion.text);
      toast.success("Regenerated");
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
          {sugg.attempt && sugg.attempt > 1 ? ` · attempt ${sugg.attempt}` : ""}
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
          {sourceCount} knowledge chunk(s) grounded this reply. Sources are never shown to the
          customer.
        </p>
      )}
      <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} className="mb-2" />
      {hasAudio && !edited && (
        <audio
          controls
          className="mb-2 h-8 w-full"
          src={`${BROWSER_API_BASE}/api/ai-assistant/suggestions/${sugg.id}/audio`}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {isVoice ? (
          <>
            <Button size="sm" disabled={busy || !text.trim()} onClick={() => void decide("accept", "voice")}>
              Send as Voice
            </Button>
            <Button size="sm" variant="secondary" disabled={busy || !text.trim()} onClick={() => void decide("accept", "text")}>
              Send as Text
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy || !text.trim()} onClick={() => void decide("accept", "text")}>
            {edited ? "Edit & Send" : "Send"}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void regenerate()}>
          Regenerate
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("reject")}>
          Reject
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void takeOver()}>
          Take over
        </Button>
      </div>
    </div>
  );
}
