"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";

/**
 * STICKER PICKER — Meta's first-party sticker catalog, in the composer.
 *
 * Reads through `/api/workspace/messenger/stickers`, which proxies Meta's three
 * catalog endpoints. Nothing is cached across opens on purpose: the catalog is
 * ~105 packs of remote images, and holding them warm in a component that lives
 * for the whole inbox session buys a rarely-repeated open at the cost of memory
 * on every thread.
 *
 * ## The like sticker is always offered
 *
 * `369239263222822` (thumbs-up) is deliberately ABSENT from Meta's catalog
 * endpoints but is always sendable. It is the single most-used sticker on
 * Messenger, so a picker that only listed the catalog would be missing the one
 * people reach for. It is pinned first and survives a catalog that fails to load
 * entirely — which is also why a load failure degrades to "just the like" rather
 * than to an empty sheet.
 *
 * ## Locale
 *
 * The agent's browser locale is forwarded on search. Without it Meta defaults to
 * `en_US` and matches only English tags, so a Vietnamese or Korean query returns
 * an empty list rather than an error — which reads to the user as "there are no
 * stickers for that", not "you searched in the wrong language".
 */
interface Sticker {
  id: string;
  name: string | null;
  imageUrl: string | null;
}
interface Pack {
  id: string;
  name: string;
  previewImageUrl: string | null;
  stickerCount: number | null;
}

const LIKE_STICKER: Sticker = {
  id: "369239263222822",
  name: "Like",
  // Meta hosts no catalog entry for it, so there is no image URL to show; the
  // tile renders the glyph instead.
  imageUrl: null,
};

/** Meta's documented minimum query length — searching below it returns nothing. */
const SEARCH_MIN_CHARS = 2;

/** `en-US` → `en_US`; Meta wants the underscore form. */
function metaLocale(): string | undefined {
  const tag = typeof navigator !== "undefined" ? navigator.language : "";
  const m = /^([a-z]{2})-([A-Z]{2})$/.exec(tag ?? "");
  return m ? `${m[1]}_${m[2]}` : undefined;
}

export function StickerPicker({
  open,
  onClose,
  onPick,
  sending,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (sticker: { id: string; imageUrl?: string }) => void;
  sending: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [openPack, setOpenPack] = useState<Pack | null>(null);
  const [query, setQuery] = useState("");
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);

  const load = useCallback(async (params: { packId?: string; q?: string }) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (params.packId) qs.set("packId", params.packId);
      if (params.q) qs.set("q", params.q);
      const locale = metaLocale();
      if (locale) qs.set("locale", locale);
      const res = await apiFetch(`/api/workspace/messenger/stickers?${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        catalog: { packs?: Pack[]; stickers?: Sticker[] } | null;
      };
      if (!body.catalog) {
        // Not an error to shout about: an older connection simply has no app
        // credentials to authenticate the catalog with. The like sticker still
        // works, so the picker stays useful.
        setCatalogUnavailable(true);
        return;
      }
      setCatalogUnavailable(false);
      if (body.catalog.packs) {
        setPacks(body.catalog.packs);
        setStickers([]);
      } else {
        setStickers(body.catalog.stickers ?? []);
      }
    } catch {
      setCatalogUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load the pack list once per open, not once per mount — the sheet stays
  // mounted between opens so the scroll position and query survive.
  const loadedForThisOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      loadedForThisOpen.current = false;
      return;
    }
    if (loadedForThisOpen.current) return;
    loadedForThisOpen.current = true;
    void load({});
  }, [open, load]);

  // Debounced search. Below Meta's minimum we return to the pack list rather
  // than firing a request that is defined to match nothing.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length === 0) {
      if (!openPack) void load({});
      return;
    }
    if (q.length < SEARCH_MIN_CHARS) return;
    const t = setTimeout(() => void load({ q }), 300);
    return () => clearTimeout(t);
  }, [query, open, openPack, load]);

  if (!open) return null;

  const showing = query.trim().length >= SEARCH_MIN_CHARS || openPack ? stickers : [];
  const tiles: Sticker[] = query.trim() ? showing : [LIKE_STICKER, ...showing];

  return (
    <div
      className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-3 shadow-lg"
      role="dialog"
      aria-label="Sticker picker"
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stickers…"
            className="h-8 pl-7 text-xs"
            aria-label="Search stickers"
            autoFocus
          />
        </div>
        <Button size="icon" variant="ghost" className="size-8" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>

      {openPack && !query.trim() && (
        <button
          type="button"
          className="mb-2 text-2xs font-medium text-primary hover:underline"
          onClick={() => {
            setOpenPack(null);
            void load({});
          }}
        >
          ← All packs
        </button>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto">
          {catalogUnavailable && (
            <p className="mb-2 text-2xs text-muted-foreground">
              Meta&apos;s sticker catalog isn&apos;t available for this Page, but
              the 👍 sticker can still be sent.
            </p>
          )}

          {/* Pack grid — only when not searching and not inside a pack. */}
          {!query.trim() && !openPack && packs.length > 0 && (
            <div className="mb-3 grid grid-cols-3 gap-2">
              {packs.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="flex flex-col items-center gap-1 rounded-lg border p-2 hover:bg-accent"
                  onClick={() => {
                    setOpenPack(p);
                    void load({ packId: p.id });
                  }}
                  title={p.name}
                >
                  {p.previewImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- remote Meta CDN, not a Next-optimizable asset
                    <img
                      src={p.previewImageUrl}
                      alt=""
                      className="size-10 object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <span className="grid size-10 place-items-center text-lg">🙂</span>
                  )}
                  <span className="w-full truncate text-center text-2xs">{p.name}</span>
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-4 gap-2">
            {tiles.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={sending}
                className={cn(
                  "grid aspect-square place-items-center rounded-lg border p-1 hover:bg-accent",
                  sending && "opacity-50",
                )}
                title={s.name ?? "Sticker"}
                aria-label={`Send ${s.name ?? "sticker"}`}
                onClick={() => {
                  onPick({ id: s.id, ...(s.imageUrl ? { imageUrl: s.imageUrl } : {}) });
                  onClose();
                }}
              >
                {s.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- remote Meta CDN, not a Next-optimizable asset
                  <img src={s.imageUrl} alt="" className="size-full object-contain" loading="lazy" />
                ) : (
                  <span className="text-2xl">👍</span>
                )}
              </button>
            ))}
          </div>

          {tiles.length === 0 && !loading && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No stickers found.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
