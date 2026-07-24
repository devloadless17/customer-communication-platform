"use client";

import { useCallback, useState } from "react";

import { apiFetch } from "@/lib/api/client-fetch";
import { HeaderMediaField } from "@/features/templates/components/header-media-field";

/**
 * Send-time values for a media-card carousel — the whole card strip in one
 * control, shared by the inbox template picker and the broadcast composer.
 *
 * The card COUNT is fixed at approval, so this component never adds or removes
 * a card: it renders exactly the shape `requiredCarouselCards` reports and
 * collects a value for each slot. Both callers send the result straight through
 * as `variables.cards`, which the server re-checks against the same helper.
 */

/** One card's requirements, as `requiredCarouselCards` reports them. */
export interface CarouselCardRequirement {
  headerKind: "image" | "video";
  bodyVarCount: number;
  buttons: Array<{ index: number; subType: "url" | "quick_reply" | "copy_code" }>;
}

/** One card's collected values, in the shape the send API takes. */
export interface CarouselCardValue {
  headerMedia: { kind: "image" | "video"; link?: string; id?: string };
  body?: string[];
  buttons?: Array<{
    index: number;
    subType: "url" | "quick_reply" | "copy_code";
    text: string;
  }>;
}

/** Empty values matching a template's card shape — the initial state. */
export function emptyCarouselCards(
  requirements: CarouselCardRequirement[],
): CarouselCardValue[] {
  return requirements.map((r) => ({
    headerMedia: { kind: r.headerKind },
    ...(r.bodyVarCount > 0
      ? { body: Array.from({ length: r.bodyVarCount }, () => "") }
      : {}),
    ...(r.buttons.length > 0
      ? { buttons: r.buttons.map((b) => ({ ...b, text: "" })) }
      : {}),
  }));
}

/** Is every slot filled? Mirrors the server's `carousel_cards_required` gate. */
export function carouselCardsComplete(
  requirements: CarouselCardRequirement[],
  values: CarouselCardValue[],
  resolve: (raw: string) => string = (v) => v,
): boolean {
  if (values.length !== requirements.length) return false;
  return requirements.every((req, i) => {
    const card = values[i];
    if (!card) return false;
    if (!card.headerMedia.link && !card.headerMedia.id) return false;
    if ((card.body?.length ?? 0) !== req.bodyVarCount) return false;
    if (!(card.body ?? []).every((v) => resolve(v).trim() !== "")) return false;
    // A quick-reply payload is optional to Meta, so it is never demanded here
    // either — `requiredCarouselCards` already leaves it out.
    return req.buttons.every((b) => {
      const value = (card.buttons ?? []).find(
        (x) => x.index === b.index && x.subType === b.subType,
      );
      return value !== undefined && resolve(value.text).trim() !== "";
    });
  });
}

export function CarouselCardsField({
  requirements,
  values,
  onChange,
  /** Per-recipient token resolution (broadcasts/inbox); identity by default. */
  resolve,
}: {
  requirements: CarouselCardRequirement[];
  values: CarouselCardValue[];
  onChange: (next: CarouselCardValue[]) => void;
  resolve?: (raw: string) => string;
}) {
  // Upload state is per-card: two cards uploading at once must not share a
  // spinner or overwrite each other's error.
  const [uploading, setUploading] = useState<Record<number, boolean>>({});
  const [errors, setErrors] = useState<Record<number, string | null>>({});

  // Built from REQUIREMENTS, not from `values`: the parent seeds `values` in an
  // effect, so a card uploaded before that lands would otherwise be mapped over
  // a shorter array and silently dropped.
  const patchCard = useCallback(
    (i: number, patch: Partial<CarouselCardValue>) => {
      const base = emptyCarouselCards(requirements);
      onChange(
        base.map((empty, idx) => {
          const current = values[idx] ?? empty;
          return idx === i ? { ...current, ...patch } : current;
        }),
      );
    },
    [requirements, values, onChange],
  );

  const upload = useCallback(
    async (i: number, file: File, kind: "image" | "video") => {
      setErrors((e) => ({ ...e, [i]: null }));
      setUploading((u) => ({ ...u, [i]: true }));
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await apiFetch("/api/messages/template-header-media", {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as {
            detail?: string;
            error?: string;
          } | null;
          setErrors((e) => ({ ...e, [i]: data?.detail ?? data?.error ?? "Upload failed" }));
          return;
        }
        const data = (await res.json()) as {
          link: string;
          kind: "image" | "video" | "document";
        };
        // The card's format is fixed by the approved template — a video card
        // cannot take an image. Meta would reject the send; say so here.
        if (data.kind !== kind) {
          setErrors((e) => ({
            ...e,
            [i]: `This card was approved as ${kind === "image" ? "an image" : "a video"} — attach ${kind === "image" ? "an image" : "a video"}.`,
          }));
          return;
        }
        patchCard(i, { headerMedia: { kind, link: data.link } });
      } catch {
        setErrors((e) => ({
          ...e,
          [i]: "Upload failed — check your connection and try again.",
        }));
      } finally {
        setUploading((u) => ({ ...u, [i]: false }));
      }
    },
    [patchCard],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {requirements.length} cards — the customer scrolls through these
      </div>
      {requirements.map((req, i) => {
        const card = values[i];
        return (
          <div
            key={i}
            className="rounded-lg border border-border bg-muted/20 p-2.5"
          >
            <div className="mb-1.5 text-2xs font-medium text-muted-foreground">
              Card {i + 1}
            </div>
            <HeaderMediaField
              kind={req.headerKind}
              media={
                card?.headerMedia.link
                  ? { kind: req.headerKind, link: card.headerMedia.link }
                  : null
              }
              uploading={uploading[i] ?? false}
              error={errors[i] ?? null}
              onPick={(file) => void upload(i, file, req.headerKind)}
              onClear={() => {
                patchCard(i, { headerMedia: { kind: req.headerKind } });
                setErrors((e) => ({ ...e, [i]: null }));
              }}
            />
            {req.bodyVarCount > 0 && (
              <div className="mt-2 flex flex-col gap-1.5">
                {Array.from({ length: req.bodyVarCount }, (_, vi) => (
                  <CardInput
                    key={vi}
                    label={`Body {{${vi + 1}}}`}
                    value={card?.body?.[vi] ?? ""}
                    resolved={resolve?.(card?.body?.[vi] ?? "")}
                    onChange={(next) =>
                      patchCard(i, {
                        body: Array.from(
                          { length: req.bodyVarCount },
                          (_, k) => (k === vi ? next : (card?.body?.[k] ?? "")),
                        ),
                      })
                    }
                  />
                ))}
              </div>
            )}
            {req.buttons.length > 0 && (
              <div className="mt-2 flex flex-col gap-1.5">
                {req.buttons.map((b) => {
                  const current = (card?.buttons ?? []).find(
                    (x) => x.index === b.index && x.subType === b.subType,
                  );
                  return (
                    <CardInput
                      key={`${b.index}:${b.subType}`}
                      label={
                        b.subType === "copy_code"
                          ? `Button ${b.index + 1} — offer code`
                          : `Button ${b.index + 1} — link value`
                      }
                      value={current?.text ?? ""}
                      resolved={resolve?.(current?.text ?? "")}
                      onChange={(next) =>
                        patchCard(i, {
                          buttons: req.buttons.map((rb) => ({
                            ...rb,
                            text:
                              rb.index === b.index && rb.subType === b.subType
                                ? next
                                : ((card?.buttons ?? []).find(
                                    (x) =>
                                      x.index === rb.index && x.subType === rb.subType,
                                  )?.text ?? ""),
                          })),
                        })
                      }
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CardInput({
  label,
  value,
  resolved,
  onChange,
}: {
  label: string;
  value: string;
  /** Token-resolved preview, when the caller resolves per recipient. */
  resolved?: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/25"
      />
      {/* Only shown when a token actually changed the value, so a plain literal
          doesn't get a redundant echo under every field. */}
      {resolved !== undefined && resolved !== value && (
        <span className="truncate text-2xs text-muted-foreground">→ {resolved}</span>
      )}
    </label>
  );
}
