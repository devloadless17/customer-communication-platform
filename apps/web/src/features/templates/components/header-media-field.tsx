"use client";

import { useRef } from "react";
import { AlertTriangle, FileText, Loader2, Paperclip, X } from "lucide-react";

import { Button } from "@/components/ui/button";

export type HeaderMediaKind = "image" | "video" | "document";

export interface HeaderMediaValue {
  kind: HeaderMediaKind;
  link: string;
  filename?: string;
}

const HEADER_MEDIA_ACCEPT: Record<HeaderMediaKind, string> = {
  image: "image/*",
  video: "video/*",
  document: ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,application/pdf",
};

/**
 * Attach + preview control for an IMAGE/VIDEO/DOCUMENT template header. Shared
 * by the inbox template picker and the broadcast composer — both POST the file
 * to `/api/messages/template-header-media` and pass the returned public link
 * back as `variables.headerMedia` on the send.
 */
export function HeaderMediaField({
  kind,
  media,
  uploading,
  error,
  onPick,
  onClear,
}: {
  kind: HeaderMediaKind;
  media: HeaderMediaValue | null;
  uploading: boolean;
  error: string | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  if (media) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2">
        {media.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.link} alt="" className="size-12 shrink-0 rounded object-cover" />
        ) : media.kind === "video" ? (
          <video src={media.link} className="size-12 shrink-0 rounded object-cover" muted />
        ) : (
          <div className="flex size-12 shrink-0 items-center justify-center rounded bg-emerald-500/10">
            <FileText className="size-5 text-emerald-600 dark:text-emerald-400" />
          </div>
        )}
        <span className="flex-1 truncate text-xs text-foreground">
          {media.filename ?? `${kind} attached`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onClear}
          aria-label="Remove media"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept={HEADER_MEDIA_ACCEPT[kind]}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="h-9 justify-start gap-2"
      >
        {uploading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Paperclip className="size-3.5" />
        )}
        {uploading ? "Uploading…" : `Attach ${kind}`}
      </Button>
      {error && (
        <div className="flex items-start gap-1.5 text-2xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
