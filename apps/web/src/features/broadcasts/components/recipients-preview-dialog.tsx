"use client";

import { useEffect, useState } from "react";
import { Loader2, Users, X } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { TagChip } from "@/features/tags/components/tag-chip";
import { formatPhone, initials } from "@ccp/shared/utils";
import type { Tag } from "@ccp/shared/types";

interface PreviewResult {
  total: number;
  sample: Array<{ id: string; name: string; phoneNumber: string; tags: Tag[] }>;
}

/**
 * "Who am I sending to?" dialog for the broadcast wizard. Opens against the
 * resolved audience (tag ids ∪ contact ids — the same union the broadcast uses
 * at create time) and shows the total plus a capped sample list.
 *
 * The parent decides when this is worth showing — i.e. for tag / group /
 * hand-picked audiences, not for "all contacts".
 */
export function RecipientsPreviewDialog({
  open,
  onClose,
  payload,
  title = "Recipients",
  subtitle,
}: {
  open: boolean;
  onClose: () => void;
  /** The audience to resolve. `null` while there's nothing to preview yet. */
  payload: { tagIds: string[]; contactIds: string[] } | null;
  title?: string;
  subtitle?: string;
}) {
  const [data, setData] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !payload) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    void (async () => {
      try {
        const res = await fetch("/api/contacts/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as PreviewResult;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setError("Couldn't load recipients");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, payload]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const hidden = data ? Math.max(0, data.total - data.sample.length) : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-16"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-border bg-card text-card-foreground shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-semibold">
              <Users className="size-4 text-muted-foreground" />
              {title}
              {data && (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary tabular-nums">
                  {data.total}
                </span>
              )}
            </h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              Resolving recipients…
            </div>
          ) : error ? (
            <div className="px-4 py-12 text-center text-sm text-destructive">{error}</div>
          ) : !data || data.total === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              No recipients match this audience.
            </div>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {data.sample.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 px-4 py-2.5">
                    <Avatar className="size-7 shrink-0">
                      <AvatarFallback className="text-[10px]">
                        {initials(c.name || c.phoneNumber)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {c.name || formatPhone(c.phoneNumber)}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {formatPhone(c.phoneNumber)}
                      </div>
                      {c.tags.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {c.tags.map((t) => (
                            <TagChip key={t.id} tag={t} size="xs" />
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {hidden > 0 && (
                <div className="border-t border-border bg-muted/20 px-4 py-2.5 text-center text-[12px] text-muted-foreground">
                  + {hidden} more recipient{hidden === 1 ? "" : "s"} not shown
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
