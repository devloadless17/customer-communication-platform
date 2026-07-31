"use client";

import { useState } from "react";
import { Paperclip, SendHorizontal, X } from "lucide-react";

import { cn } from "@ccp/shared/utils";

import { formatBytes } from "./ticket-attachment-row";

/**
 * The thread composer.
 *
 * Enter sends, Shift+Enter breaks the line — the same contract as every other
 * chat surface in the app, because this IS one. Files ride the message rather
 * than landing in the ticket's Files section: evidence read next to the
 * sentence explaining it is the whole reason to attach it to a reply.
 */

/** Matches MAX_FILES_PER_REQUEST on the API — refused server-side either way. */
const MAX_FILES = 5;

export function TicketThreadComposer({
  busy,
  audience,
  onSubmit,
}: {
  busy: boolean;
  /** Who reads this. Empty on an unshared ticket. */
  audience: string;
  onSubmit: (body: string, files: File[]) => void;
}) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const canSend = value.trim().length > 0 || files.length > 0;

  const send = () => {
    if (!canSend) return;
    const body = value.trim();
    const picked = files;
    // Cleared BEFORE the await: the optimistic row is already in the thread, so
    // leaving the text sitting in the box reads as "it didn't send".
    setValue("");
    setFiles([]);
    onSubmit(body, picked);
  };

  return (
    <div className="rounded-xl border bg-card p-2.5">
      {files.length > 0 ? (
        <ul className="mb-2 flex flex-col gap-1">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-2xs"
            >
              <Paperclip aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-3xs text-muted-foreground">{formatBytes(f.size)}</span>
              <button
                type="button"
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
                aria-label={`Remove ${f.name}`}
                className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
              >
                <X aria-hidden className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        rows={2}
        maxLength={5000}
        placeholder={
          audience
            ? `Reply to ${audience}…`
            : "Write on this ticket… e.g. Refund approved — tell them 3–5 business days."
        }
        className="w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-xs leading-relaxed shadow-none focus-visible:border-input focus-visible:outline-none"
        aria-label="Reply on this ticket"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !canSend}
          onClick={send}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <SendHorizontal aria-hidden className="size-3.5" />
          Send
        </button>
        <label
          className={cn(
            "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-xs font-medium",
            (busy || files.length >= MAX_FILES) && "pointer-events-none opacity-50",
          )}
        >
          <Paperclip aria-hidden className="size-3.5" />
          Attach
          <input
            type="file"
            multiple
            disabled={busy}
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              // Reset so choosing the SAME file twice still fires a change.
              e.target.value = "";
              if (picked.length > 0) setFiles((prev) => [...prev, ...picked].slice(0, MAX_FILES));
            }}
          />
        </label>
        <span className="text-3xs text-muted-foreground">
          {audience ? `Visible to ${audience} · ` : ""}Enter to send
        </span>
      </div>
    </div>
  );
}
