"use client";

import { useCallback, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Plus, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";
import { CAROUSEL_LIMITS } from "@ccp/shared/template-render";

/**
 * Authoring control for a media-card carousel.
 *
 * The one rule that shapes this whole component: **every card must carry the
 * same components**. Rather than let an author build divergent cards and then
 * fail Meta's review, the STRUCTURE is edited once at the top (does a card have
 * body text? which buttons?) and each card only fills in its own content. That
 * makes the uniformity rule unbreakable by construction instead of something
 * the validator has to catch after the fact.
 *
 * Card count is likewise fixed once approved, so it is only editable here, at
 * creation.
 */

export interface CarouselButtonDraft {
  kind: "QUICK_REPLY" | "URL";
  text: string;
  /** URL buttons only. A `{{1}}` suffix makes it per-send. */
  url: string;
  /** Example for the URL's `{{1}}`, required by Meta when one is present. */
  example: string;
  /**
   * The ORIGINAL Meta button object, kept when editing a synced template so
   * properties this editor doesn't model — and a button TYPE it can't
   * represent (a Manager-authored COPY_CODE card button) — survive the
   * round-trip instead of being rewritten as QUICK_REPLY. Same discipline as
   * `ButtonRow.raw` for the top-level buttons. Absent on new buttons.
   */
  raw?: Record<string, unknown>;
}

export interface CarouselCardDraft {
  id: string;
  /** Meta media handle from the upload route; null until one lands. */
  handle: string | null;
  filename: string;
  body: string;
  buttons: CarouselButtonDraft[];
}

export interface CarouselDraft {
  enabled: boolean;
  headerFormat: "IMAGE" | "VIDEO";
  /** Structure shared by every card. */
  hasBody: boolean;
  cards: CarouselCardDraft[];
}

export function emptyCarouselCard(): CarouselCardDraft {
  return {
    id: Math.random().toString(36).slice(2),
    handle: null,
    filename: "",
    body: "",
    buttons: [],
  };
}

export function emptyCarouselDraft(): CarouselDraft {
  return {
    enabled: false,
    headerFormat: "IMAGE",
    hasBody: false,
    cards: [emptyCarouselCard(), emptyCarouselCard()],
  };
}

/**
 * The draft in Meta's component shape. Buttons are mirrored across cards by
 * TYPE and ORDER (each card keeps its own label/URL), which is exactly the
 * uniformity Meta requires.
 */
export function carouselDraftToComponent(draft: CarouselDraft) {
  return {
    type: "CAROUSEL" as const,
    cards: draft.cards.map((card) => ({
      components: [
        {
          type: "HEADER" as const,
          format: draft.headerFormat,
          ...(card.handle ? { example: { header_handle: [card.handle] } } : {}),
        },
        ...(draft.hasBody ? [{ type: "BODY" as const, text: card.body }] : []),
        ...(card.buttons.length > 0
          ? [{ type: "BUTTONS" as const, buttons: card.buttons.map(toMetaCardButton) }]
          : []),
      ],
    })),
  };
}

/**
 * One card button in Meta's shape.
 *
 * Mirrors `toMetaButton` for the top-level buttons: properties this editor
 * doesn't model ride through from the original object, and a type it can't
 * represent keeps its ORIGINAL type on the way out — rewriting a Manager-
 * authored COPY_CODE card button as quick_reply silently mutated a
 * Meta-approved component on every edit resubmission.
 */
function toMetaCardButton(b: CarouselButtonDraft) {
  const {
    type: rawType,
    text: _text,
    url: _url,
    example: _example,
    ...passthrough
  } = (b.raw ?? {}) as Record<string, unknown>;

  if (b.kind === "URL") {
    return {
      ...passthrough,
      type: "URL",
      text: b.text,
      url: b.url,
      ...(b.url.includes("{{") ? { example: [b.example] } : {}),
    };
  }
  const keepType =
    typeof rawType === "string" && rawType.toUpperCase() !== "QUICK_REPLY"
      ? rawType
      : "QUICK_REPLY";
  return { ...passthrough, type: keepType, text: b.text };
}

export function CarouselEditor({
  draft,
  onChange,
  issues,
  editingTemplateId = null,
}: {
  draft: CarouselDraft;
  onChange: (next: CarouselDraft) => void;
  /** Messages from the shared validator, rendered verbatim. */
  issues: string[];
  /** Set on an EDIT — card uploads then scope by template, not accountId. */
  editingTemplateId?: string | null;
}) {
  const patch = useCallback(
    (p: Partial<CarouselDraft>) => onChange({ ...draft, ...p }),
    [draft, onChange],
  );
  const patchCard = useCallback(
    (id: string, p: Partial<CarouselCardDraft>) =>
      onChange({
        ...draft,
        cards: draft.cards.map((c) => (c.id === id ? { ...c, ...p } : c)),
      }),
    [draft, onChange],
  );

  // Buttons are structural: adding one adds the same slot to EVERY card, so a
  // card can never end up with a button its siblings lack.
  const addButton = useCallback(
    (kind: CarouselButtonDraft["kind"]) =>
      onChange({
        ...draft,
        cards: draft.cards.map((c) => ({
          ...c,
          buttons: [...c.buttons, { kind, text: "", url: "", example: "" }],
        })),
      }),
    [draft, onChange],
  );
  const removeButton = useCallback(
    (index: number) =>
      onChange({
        ...draft,
        cards: draft.cards.map((c) => ({
          ...c,
          buttons: c.buttons.filter((_, i) => i !== index),
        })),
      }),
    [draft, onChange],
  );

  const buttonSlots = draft.cards[0]?.buttons ?? [];

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="mt-0.5 size-3.5 accent-primary"
        />
        <span className="text-xs leading-relaxed text-muted-foreground">
          Add a scrollable strip of product cards under the message. Every card
          shares the same shape — WhatsApp renders them at one height — so you
          set the structure once and fill in each card&apos;s own content.
        </span>
      </label>

      {draft.enabled && (
        <>
          {/* Structure, shared by every card */}
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <div className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Card structure
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StructurePill
                active={draft.headerFormat === "IMAGE"}
                onClick={() => patch({ headerFormat: "IMAGE" })}
              >
                Image cards
              </StructurePill>
              <StructurePill
                active={draft.headerFormat === "VIDEO"}
                onClick={() => patch({ headerFormat: "VIDEO" })}
              >
                Video cards
              </StructurePill>
              <StructurePill
                active={draft.hasBody}
                onClick={() => patch({ hasBody: !draft.hasBody })}
              >
                Card text
              </StructurePill>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {buttonSlots.map((b, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-2xs"
                >
                  {b.kind === "URL" ? "Link button" : "Quick reply"}
                  <button
                    type="button"
                    onClick={() => removeButton(i)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove button ${i + 1}`}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </span>
              ))}
              {buttonSlots.length < CAROUSEL_LIMITS.maxButtonsPerCard && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-2xs"
                    onClick={() => addButton("QUICK_REPLY")}
                  >
                    <Plus className="size-3" /> Quick reply
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-2xs"
                    onClick={() => addButton("URL")}
                  >
                    <Plus className="size-3" /> Link button
                  </Button>
                </>
              )}
            </div>
          </div>

          {draft.cards.map((card, i) => (
            <CardRow
              key={card.id}
              index={i}
              card={card}
              draft={draft}
              editingTemplateId={editingTemplateId}
              onPatch={(p) => patchCard(card.id, p)}
              onRemove={
                draft.cards.length > CAROUSEL_LIMITS.minCards
                  ? () =>
                      onChange({
                        ...draft,
                        cards: draft.cards.filter((c) => c.id !== card.id),
                      })
                  : undefined
              }
            />
          ))}

          {draft.cards.length < CAROUSEL_LIMITS.maxCards && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 self-start text-2xs"
              onClick={() =>
                onChange({
                  ...draft,
                  // A new card inherits the shared button structure, empty.
                  cards: [
                    ...draft.cards,
                    {
                      ...emptyCarouselCard(),
                      buttons: buttonSlots.map((b) => ({
                        kind: b.kind,
                        text: "",
                        url: "",
                        example: "",
                        // Carry the slot's raw type too, or a card added to a
                        // carousel with an unrepresentable button type would
                        // emit a quick_reply where its siblings emit theirs —
                        // Meta requires every card to match.
                        ...(b.raw ? { raw: b.raw } : {}),
                      })),
                    },
                  ],
                })
              }
            >
              <Plus className="size-3.5" /> Add card ({draft.cards.length}/
              {CAROUSEL_LIMITS.maxCards})
            </Button>
          )}

          {issues.map((m) => (
            <p key={m} className="text-2xs text-destructive">
              {m}
            </p>
          ))}
          <p className="text-2xs text-muted-foreground">
            The card count is locked once Meta approves the template — a send
            must supply exactly {draft.cards.length}.
          </p>
        </>
      )}
    </div>
  );
}

function CardRow({
  index,
  card,
  draft,
  editingTemplateId,
  onPatch,
  onRemove,
}: {
  index: number;
  card: CarouselCardDraft;
  draft: CarouselDraft;
  editingTemplateId: string | null;
  onPatch: (p: Partial<CarouselCardDraft>) => void;
  /** Absent while at the 2-card minimum. */
  onRemove?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Account scope from the page URL (stamped by the templates view) — the
  // header asset uploads under the app the template's WABA account uses.
  const searchParams = useSearchParams();
  const templateAccountId = searchParams?.get("accountId") ?? null;
  const templateAccountQuery = templateAccountId
    ? `?accountId=${encodeURIComponent(templateAccountId)}`
    : "";
  // On an EDIT, name the template instead of the account: the server resolves
  // the WABA from the row rather than trusting a query param a link is free to
  // drop — same rule as the form's own header upload (onHeaderFileChange).
  const uploadQuery = editingTemplateId
    ? `?templateId=${encodeURIComponent(editingTemplateId)}`
    : templateAccountQuery;

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);
      // Same 120s ceiling the main header upload uses — a stalled connection
      // must not leave the row spinning forever.
      const abort = new AbortController();
      const timeoutId = window.setTimeout(() => abort.abort(), 120_000);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await apiFetch(
          // Same scope the template-form's own uploads carry — templateId on
          // an edit, the page URL's accountId on a create — so the card asset
          // is minted under the app the template's WABA account uses.
          `/api/workspace/whatsapp/templates/upload-media${uploadQuery}`,
          {
            method: "POST",
            body: fd,
            signal: abort.signal,
          },
        );
        const data = (await res.json()) as {
          headerHandle?: string;
          error?: string;
          detail?: string;
        };
        if (!res.ok || !data.headerHandle) {
          throw new Error(
            [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
          );
        }
        onPatch({ handle: data.headerHandle, filename: file.name });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          setError("Upload timed out. Try a smaller file.");
        } else {
          setError(err instanceof Error ? err.message : "Upload failed");
        }
        onPatch({ handle: null, filename: "" });
      } finally {
        window.clearTimeout(timeoutId);
        setUploading(false);
      }
    },
    [onPatch, uploadQuery],
  );

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-2xs font-medium text-muted-foreground">
          Card {index + 1}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Remove card ${index + 1}`}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={draft.headerFormat === "IMAGE" ? "image/*" : "video/*"}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="h-8 gap-1.5 text-2xs"
      >
        {uploading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Upload className="size-3.5" />
        )}
        {card.handle
          ? `Replace ${draft.headerFormat.toLowerCase()}`
          : `Upload ${draft.headerFormat.toLowerCase()}`}
      </Button>
      {card.filename && (
        <span className="ml-2 text-2xs text-muted-foreground">{card.filename}</span>
      )}
      {error && <p className="mt-1 text-2xs text-destructive">{error}</p>}

      {draft.hasBody && (
        <Textarea
          value={card.body}
          onChange={(e) => onPatch({ body: e.target.value })}
          placeholder="Rare and beautiful, ready to ship."
          rows={2}
          maxLength={CAROUSEL_LIMITS.cardBodyMaxLength}
          className="mt-2 text-xs"
        />
      )}
      {draft.hasBody && (
        <p className="mt-1 text-2xs text-muted-foreground">
          <span
            className={cn(
              card.body.length > CAROUSEL_LIMITS.cardBodyMaxLength &&
                "text-destructive",
            )}
          >
            {card.body.length}/{CAROUSEL_LIMITS.cardBodyMaxLength}
          </span>
        </p>
      )}

      {card.buttons.map((b, bi) => (
        <div key={bi} className="mt-2 flex flex-col gap-1.5">
          <Input
            value={b.text}
            onChange={(e) =>
              onPatch({
                buttons: card.buttons.map((x, i) =>
                  i === bi ? { ...x, text: e.target.value } : x,
                ),
              })
            }
            placeholder={b.kind === "URL" ? "Shop" : "Send me more like this!"}
            maxLength={25}
            className="h-8 text-xs"
          />
          {b.kind === "URL" && (
            <>
              <Input
                value={b.url}
                onChange={(e) =>
                  onPatch({
                    buttons: card.buttons.map((x, i) =>
                      i === bi ? { ...x, url: e.target.value } : x,
                    ),
                  })
                }
                placeholder="https://example.com/products/{{1}}"
                className="h-8 text-xs"
              />
              {b.url.includes("{{") && (
                <Input
                  value={b.example}
                  onChange={(e) =>
                    onPatch({
                      buttons: card.buttons.map((x, i) =>
                        i === bi ? { ...x, example: e.target.value } : x,
                      ),
                    })
                  }
                  placeholder="Example value — e.g. BLUE_ELF"
                  className="h-8 text-xs"
                />
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function StructurePill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-2xs transition",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
