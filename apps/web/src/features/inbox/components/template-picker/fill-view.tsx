"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, FileText, Loader2, Send } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";
import { HeaderMediaField, headerMediaPreviewSrc } from "@/features/templates/components/header-media-field";
import {
  CarouselCardsField,
  carouselCardsComplete,
  emptyCarouselCards,
  type CarouselCardValue,
} from "@/features/templates/components/carousel-cards-field";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import type {
  Contact,
  ContactFieldDefinition,
  ContactStage,
  Tag,
  TemplateDto,
  User,
} from "@ccp/shared/types";
import {
  buildCustomFieldsDisplay,
  resolveFieldTokens,
  type ContactLike,
} from "@ccp/shared/field-tokens";
import { FieldTokenPicker } from "@/features/templates/components/field-token-picker";
import { TokenHighlightInput } from "@/features/templates/components/token-highlight";

import {
  templateNamedPlaceholders,
  renderTemplateBodyNamed,
  requiredCarouselCards,
  requiredTemplateButtonParams,
  templateNeedsOfferExpiry,
} from "@ccp/shared/template-render";

import {
  asArray,
  countPlaceholders,
  extractExample,
  firstEmptyIndex,
  renderPlaceholders,
} from "./utils";

export function TemplateFillView({
  template,
  sending,
  sendError,
  contact,
  currentUser,
  stageCatalog,
  tags,
  fieldDefinitions,
  lastInboundAt,
  onSubmit,
}: {
  template: TemplateDto;
  sending: boolean;
  sendError: string | null;
  /** Conversation contact — token target + preview source. */
  contact: Contact;
  /** The agent sending — drives `$var.agent.*` tokens. */
  currentUser: User;
  /** Stage catalog — resolves `$var.contact.stage_name` (contact carries only stageId). */
  stageCatalog: ContactStage[];
  /** Tag catalog — resolves `$var.contact.tag_names`. */
  tags: Tag[];
  /** Team custom-field schema — drives the picker dropdown. */
  fieldDefinitions: ContactFieldDefinition[];
  /** Last inbound timestamp — folded into ContactLike for window-state tokens. */
  lastInboundAt: string | null;
  onSubmit: (vars: {
    body: string[];
    bodyNamed?: Array<{ name: string; text: string }>;
    header?: string;
    headerMedia?: { kind: "image" | "video" | "document"; link: string; filename?: string };
    headerLocation?: { latitude: string; longitude: string; name: string; address: string };
    buttons?: Array<{ index: number; subType: "url" | "copy_code" | "quick_reply"; text: string }>;
    /** Limited-time offer expiry, UNIX ms. Required when the template shows a
     *  countdown — Meta has nothing to count to without it. */
    limitedTimeOfferExpiresAtMs?: number;
    /** Per-card values for a media-card carousel, in card order. The length
     *  must equal the card count the template was APPROVED with. */
    cards?: Array<{
      headerMedia: { kind: "image" | "video"; link?: string; id?: string };
      body?: string[];
      buttons?: Array<{
        index: number;
        subType: "url" | "quick_reply" | "copy_code";
        text: string;
      }>;
    }>;
  }) => Promise<void>;
}) {
  // The DTO carries `components: unknown[]` to keep the boundary loose;
  // narrow once here so the rest of the component sees a real shape. Memoized
  // on the template so the derived memos below keep a stable dependency — a
  // fresh array each render would recompute them on every keystroke.
  const components = useMemo(
    () =>
      (Array.isArray(template.components) ? template.components : []) as TemplateComponent[],
    [template.components],
  );
  const headerComp = components.find((c) => c.type === "HEADER");
  const bodyComp = components.find((c) => c.type === "BODY");
  const footerComp = components.find((c) => c.type === "FOOTER");
  const buttonsComp = components.find((c) => c.type === "BUTTONS");

  // A body is EITHER positional (`{{1}}`) or NAMED (`{{order_id}}`), and WHICH
  // one is Meta's own `parameter_format` — carried on the DTO — not something to
  // re-derive from the text. Sniffing the body with a regex misreads a positional
  // template that contains the literal copy `{{order_id}}`, and the send then
  // builds the named wire shape and fails with Meta error 132000. The server
  // reads the same column, so the two can no longer disagree about a template.
  const isNamed = template.parameterFormat === "named";
  const bodyNamedVars = useMemo(
    () => (isNamed ? templateNamedPlaceholders(template.bodyText) : []),
    [isNamed, template.bodyText],
  );
  const bodyVarCount = isNamed ? bodyNamedVars.length : countPlaceholders(template.bodyText);
  // The header carries at most one value; the server pairs it back to the
  // placeholder NAME for named templates, so the UI only needs "is there one".
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? isNamed
        ? templateNamedPlaceholders(headerComp.text).length
        : countPlaceholders(headerComp.text)
      : 0;
  // A LOCATION header carries its whole pin at send time.
  const needsLocation = headerComp?.format === "LOCATION";
  // A limited-time offer renders a live countdown, so the expiry INSTANT is a
  // send-time value (the template only declares the offer heading).
  const needsOfferExpiry = templateNeedsOfferExpiry(components);
  // Carousel cards. The count is fixed at approval, so this drives the whole
  // card strip — the UI never offers to add or remove one.
  const cardRequirements = useMemo(
    () => requiredCarouselCards(components),
    [components],
  );
  // Buttons Meta REQUIRES a send-time value for: a URL button with a `{{n}}`
  // suffix, and a copy-code coupon. Same helper the server validates with, so the
  // picker can no longer render a template it will then refuse to send.
  const requiredButtons = useMemo(
    () => requiredTemplateButtonParams(components, template.category),
    [components, template.category],
  );
  // IMAGE/VIDEO/DOCUMENT headers need real media supplied at send time.
  const headerMediaKind: "image" | "video" | "document" | null =
    headerComp?.format === "IMAGE"
      ? "image"
      : headerComp?.format === "VIDEO"
        ? "video"
        : headerComp?.format === "DOCUMENT"
          ? "document"
          : null;

  const [bodyVars, setBodyVars] = useState<string[]>(() =>
    Array.from({ length: bodyVarCount }, () => ""),
  );
  const [headerVar, setHeaderVar] = useState("");
  const [headerMedia, setHeaderMedia] = useState<{
    kind: "image" | "video" | "document";
    link: string;
    filename?: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [location, setLocation] = useState({
    latitude: "",
    longitude: "",
    name: "",
    address: "",
  });
  // Keyed `index:subType` so a template with two dynamic buttons keeps them
  // apart even when both are URLs.
  const [buttonVars, setButtonVars] = useState<Record<string, string>>({});
  // `datetime-local` value ("YYYY-MM-DDTHH:mm") — local wall-clock, which is
  // what an agent thinks in. Converted to UNIX ms on submit.
  const [offerExpiresAt, setOfferExpiresAt] = useState("");
  const [cards, setCards] = useState<CarouselCardValue[]>(() =>
    emptyCarouselCards(cardRequirements),
  );

  // Reset whenever the template changes — agents pick template A, back out,
  // pick template B; we don't want B's slots prefilled with A's values.
  useEffect(() => {
    setBodyVars(Array.from({ length: bodyVarCount }, () => ""));
    setHeaderVar("");
    setHeaderMedia(null);
    setUploadError(null);
    setLocation({ latitude: "", longitude: "", name: "", address: "" });
    setButtonVars({});
    setOfferExpiresAt("");
    setCards(emptyCarouselCards(cardRequirements));
  }, [template.id, bodyVarCount, cardRequirements]);

  const uploadHeaderMedia = useCallback(
    async (file: File) => {
      setUploadError(null);
      setUploading(true);
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
          setUploadError(data?.detail ?? data?.error ?? "Upload failed");
          return;
        }
        const data = (await res.json()) as {
          link: string;
          kind: "image" | "video" | "document";
          filename?: string;
        };
        setHeaderMedia({ kind: data.kind, link: data.link, filename: data.filename });
      } catch {
        setUploadError("Upload failed — check your connection and try again.");
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const firstEmptyRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstEmptyRef.current?.focus();
  }, [template.id]);

  // ContactLike for token resolution — mirrors the snippet picker's shape in
  // ReplyBox so `$var.contact.stage_name` / `$var.contact.tag_names` resolve
  // off the catalogs (the contact row carries only ids).
  const contactForTokens = useMemo<ContactLike>(
    () => ({
      name: contact.name,
      phoneNumber: contact.phoneNumber,
      email: contact.email ?? null,
      location: contact.location ?? null,
      customFields: contact.customFields ?? {},
      // Select-type fields store option IDs; render the option NAME.
      customFieldsDisplay: buildCustomFieldsDisplay(
        fieldDefinitions,
        contact.customFields ?? {},
      ),
      lastInboundAt,
      stageName: contact.stageId
        ? stageCatalog.find((s) => s.id === contact.stageId)?.name ?? null
        : null,
      tagNames: (contact.tagIds ?? [])
        .map((id) => tags.find((t) => t.id === id)?.name)
        .filter((n): n is string => typeof n === "string"),
    }),
    [contact, fieldDefinitions, stageCatalog, tags, lastInboundAt],
  );

  // Resolve a single field's text against the conversation's contact. Empty
  // input passes through as empty — the form's "all filled" gate uses the
  // RESOLVED value so an unfilled token (e.g. blank email) blocks send.
  const resolve = useCallback(
    (raw: string) => resolveFieldTokens(raw, contactForTokens, currentUser),
    [contactForTokens, currentUser],
  );

  const resolvedBodyVars = useMemo(
    () => bodyVars.map(resolve),
    [bodyVars, resolve],
  );
  const resolvedHeaderVar = useMemo(() => resolve(headerVar), [headerVar, resolve]);

  // `null` when unset OR already past — both block the send.
  const offerExpiryMs = useMemo(() => {
    if (!offerExpiresAt) return null;
    const ms = new Date(offerExpiresAt).getTime();
    return Number.isFinite(ms) && ms > Date.now() ? ms : null;
  }, [offerExpiresAt]);

  const allFilled =
    resolvedBodyVars.every((v) => v.trim().length > 0) &&
    (headerVarCount === 0 || resolvedHeaderVar.trim().length > 0) &&
    (headerMediaKind === null || headerMedia !== null) &&
    // Only the coordinates are required — Meta treats the place name and
    // address as optional labels on the map card.
    (!needsLocation ||
      (location.latitude.trim() !== "" && location.longitude.trim() !== "")) &&
    // Gate on the RESOLVED value, exactly like the body fields: a `$var.…`
    // token that resolves to empty for this contact must block the send, not
    // sail through and be rejected by Meta.
    requiredButtons.every(
      (b) => resolve(buttonVars[`${b.index}:${b.subType}`] ?? "").trim() !== "",
    ) &&
    // A countdown to a past instant arrives already expired, so the gate is
    // "in the future", not merely "filled in".
    (!needsOfferExpiry || offerExpiryMs !== null) &&
    // Gate on the RESOLVED card values for the same reason the body fields do:
    // a `$var.…` token that comes out empty for this contact must block.
    (cardRequirements.length === 0 ||
      carouselCardsComplete(cardRequirements, cards, resolve));

  return (
    <form
      className="flex max-h-130 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (!allFilled || sending) return;
        // Resolve tokens BEFORE handing to the parent — the server's template
        // send path doesn't run a token resolver (broadcasts + workflows do,
        // but per-conversation template send doesn't), so the on-the-wire
        // variables must already be literal strings.
        void onSubmit({
          // A named template puts its values in `bodyNamed` and sends an empty
          // `body` — the server picks the arm off the template's own format, so
          // filling both would be ambiguous.
          body: isNamed ? [] : resolvedBodyVars,
          ...(isNamed
            ? {
                bodyNamed: bodyNamedVars.map((name, i) => ({
                  name,
                  text: resolvedBodyVars[i] ?? "",
                })),
              }
            : {}),
          ...(headerVarCount > 0 ? { header: resolvedHeaderVar } : {}),
          ...(headerMedia ? { headerMedia } : {}),
          ...(needsLocation ? { headerLocation: location } : {}),
          ...(offerExpiryMs !== null ? { limitedTimeOfferExpiresAtMs: offerExpiryMs } : {}),
          ...(cardRequirements.length > 0
            ? {
                cards: cards.map((c) => ({
                  ...c,
                  ...(c.body ? { body: c.body.map(resolve) } : {}),
                  ...(c.buttons
                    ? { buttons: c.buttons.map((b) => ({ ...b, text: resolve(b.text) })) }
                    : {}),
                })),
              }
            : {}),
          ...(requiredButtons.length > 0
            ? {
                buttons: requiredButtons.map((b) => ({
                  index: b.index,
                  subType: b.subType,
                  text: resolve(buttonVars[`${b.index}:${b.subType}`] ?? ""),
                })),
              }
            : {}),
        });
      }}
    >
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {/* Media header attachment — required for IMAGE/VIDEO/DOCUMENT headers */}
        {headerMediaKind && (
          <div className="mb-4">
            <div className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {headerMediaKind} header
            </div>
            <HeaderMediaField
              kind={headerMediaKind}
              media={headerMedia}
              uploading={uploading}
              error={uploadError}
              onPick={uploadHeaderMedia}
              onClear={() => {
                setHeaderMedia(null);
                setUploadError(null);
              }}
            />
          </div>
        )}

        {/* Location header — the pin ships at SEND time (the component is
            declared with no parameters at create time), so all four fields are
            collected here. */}
        {needsLocation && (
          <div className="mb-4 flex flex-col gap-2">
            <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Map header
            </div>
            <div className="grid grid-cols-2 gap-2">
              <LocationField
                label="Latitude"
                placeholder="37.442117"
                value={location.latitude}
                onChange={(v) => setLocation((c) => ({ ...c, latitude: v }))}
              />
              <LocationField
                label="Longitude"
                placeholder="-122.161560"
                value={location.longitude}
                onChange={(v) => setLocation((c) => ({ ...c, longitude: v }))}
              />
            </div>
            <LocationField
              label="Place name (optional)"
              placeholder="Philz Coffee"
              value={location.name}
              onChange={(v) => setLocation((c) => ({ ...c, name: v }))}
            />
            <LocationField
              label="Address (optional)"
              placeholder="101 Forest Ave, Palo Alto, CA 94301"
              value={location.address}
              onChange={(v) => setLocation((c) => ({ ...c, address: v }))}
            />
          </div>
        )}

        {cardRequirements.length > 0 && (
          <div className="mb-4">
            <CarouselCardsField
              requirements={cardRequirements}
              values={cards}
              onChange={setCards}
              resolve={resolve}
            />
          </div>
        )}

        {/* Limited-time offer — the countdown's target instant. Declared once
            on the template (heading + code); WHEN it expires is per-send. */}
        {needsOfferExpiry && (
          <div className="mb-4 flex flex-col gap-1.5">
            <label
              htmlFor="lto-expiry"
              className="text-2xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Offer expires
            </label>
            <input
              id="lto-expiry"
              type="datetime-local"
              value={offerExpiresAt}
              onChange={(e) => setOfferExpiresAt(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/25"
            />
            <p className="text-2xs text-muted-foreground">
              {offerExpiresAt && offerExpiryMs === null
                ? "Pick a time in the future — the countdown would already be over."
                : "WhatsApp shows a live countdown to this time in the recipient's timezone."}
            </p>
          </div>
        )}

        {/* Variables form */}
        {bodyVarCount + headerVarCount > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Fill the placeholders
            </div>
            {headerVarCount > 0 && (
              <VarField
                label="Header {{1}}"
                value={headerVar}
                resolved={resolvedHeaderVar}
                onChange={setHeaderVar}
                placeholder={extractExample(headerComp?.example?.header_text, 0)}
                inputRef={headerVar.length === 0 ? firstEmptyRef : undefined}
                fieldDefinitions={fieldDefinitions}
              />
            )}
            {bodyVars.map((v, i) => (
              <VarField
                key={i}
                label={isNamed ? `{{${bodyNamedVars[i]}}}` : `Body {{${i + 1}}}`}
                value={v}
                resolved={resolvedBodyVars[i] ?? ""}
                onChange={(next) => {
                  setBodyVars((cur) => {
                    const copy = cur.slice();
                    copy[i] = next;
                    return copy;
                  });
                }}
                // The BODY component's example — not the header's. Reading
                // `headerComp.example.body_text` meant every body field lost
                // its "e.g. …" hint (a header component never carries one).
                placeholder={
                  isNamed
                    ? bodyComp?.example?.body_text_named_params?.find(
                        (p) => p.param_name === bodyNamedVars[i],
                      )?.example
                    : extractExample(bodyComp?.example?.body_text?.[0], i)
                }
                inputRef={
                  headerVarCount === 0 && i === firstEmptyIndex(bodyVars)
                    ? firstEmptyRef
                    : undefined
                }
                fieldDefinitions={fieldDefinitions}
              />
            ))}
          </div>
        ) : (
          !needsLocation &&
          requiredButtons.length === 0 && (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-2xs text-muted-foreground">
              This template has no variables — it&apos;ll send as-is.
            </div>
          )
        )}

        {/* Dynamic button values. Meta REQUIRES these — a URL button with a
            `{{n}}` suffix, or a copy-code coupon — and rejects the send without
            them. The picker used to render such buttons read-only in the
            preview, so the agent hit `button_params_required` with no field to
            fill: the template was simply un-sendable from the inbox. */}
        {requiredButtons.length > 0 && (
          <div className="mt-4 flex flex-col gap-3">
            <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Button values
            </div>
            {requiredButtons.map((b) => {
              const btn = buttonsComp?.buttons?.[b.index];
              const k = `${b.index}:${b.subType}`;
              return (
                <VarField
                  key={k}
                  label={
                    b.subType === "copy_code"
                      ? `Coupon code${btn?.text ? ` — ${btn.text}` : ""}`
                      : `Link suffix — ${btn?.text ?? `button ${b.index + 1}`}`
                  }
                  value={buttonVars[k] ?? ""}
                  resolved={resolve(buttonVars[k] ?? "")}
                  onChange={(next) => setButtonVars((cur) => ({ ...cur, [k]: next }))}
                  placeholder={
                    b.subType === "copy_code"
                      ? extractExample(asArray(btn?.example), 0) ?? "250FF"
                      : extractExample(asArray(btn?.example), 0) ?? "summer2023"
                  }
                  fieldDefinitions={fieldDefinitions}
                />
              );
            })}
            {requiredButtons.some((b) => b.subType === "url") && (
              <p className="text-3xs text-muted-foreground">
                The value is appended to the button&apos;s URL. Percent-encode
                spaces and special characters (a space becomes %20).
              </p>
            )}
          </div>
        )}

        {/* Preview — uses RESOLVED values so the agent sees exactly what the
            customer will receive (not the raw `$var.contact.name` tokens). */}
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            <span>Preview</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <PreviewBubble
            headerComp={headerComp}
            headerValue={resolvedHeaderVar}
            headerMedia={headerMedia}
            bodyText={template.bodyText}
            bodyVars={resolvedBodyVars}
            bodyNames={isNamed ? bodyNamedVars : null}
            footerComp={footerComp}
            buttonsComp={buttonsComp}
          />
        </div>
      </div>

      {sendError && (
        <div className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{sendError}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3">
        <div className="text-2xs text-muted-foreground">
          <Check className="mr-1 inline size-3 text-success-fg" />
          Sending opens a fresh 24h window after the customer replies.
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={!allFilled || sending}
          className="h-8 gap-1.5"
        >
          {sending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          {sending ? "Sending…" : "Send template"}
        </Button>
      </div>
    </form>
  );
}

/**
 * One plain field of a LOCATION header's pin. Deliberately NOT a `VarField`:
 * these values go to Meta as map coordinates, so `$var.contact.*` token
 * substitution would be meaningless here and the token affordance would only
 * invite a value Meta rejects.
 */
function LocationField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </label>
  );
}

function VarField({
  label,
  value,
  resolved,
  onChange,
  placeholder,
  inputRef,
  fieldDefinitions,
}: {
  label: string;
  /** Raw input, may contain `$var.contact.*` tokens. */
  value: string;
  /** Token-resolved value for this contact — used to hint "Will send as: …"
   *  when a token is present, mirroring the broadcast form's pattern. */
  resolved: string;
  onChange: (next: string) => void;
  placeholder?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  fieldDefinitions: ContactFieldDefinition[];
}) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = (inputRef ?? localRef) as React.RefObject<HTMLInputElement>;

  // Splice the token at the current cursor (same pattern as the broadcast
  // form's VarField). Falls back to append when the field isn't focused.
  const insertToken = useCallback(
    (token: string) => {
      const el = ref.current;
      if (!el || el.selectionStart === null) {
        onChange(value + token);
        return;
      }
      const start = el.selectionStart;
      const end = el.selectionEnd ?? start;
      onChange(value.slice(0, start) + token + value.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [value, onChange, ref],
  );

  const hasToken = /\$var\.(contact|agent)\./.test(value);

  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-2xs font-medium text-foreground">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <TokenHighlightInput
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ? `e.g. ${placeholder}` : "Type a value or insert $var.contact.name"}
          fieldDefinitions={fieldDefinitions}
          className="h-9 text-sm"
        />
        <FieldTokenPicker
          fieldDefinitions={fieldDefinitions}
          onInsert={insertToken}
          includeAgent
          hint="Tokens are replaced with this contact's data when you send."
        />
      </div>
      {hasToken && (
        <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="font-medium">Will send:</span>
          <span className="truncate font-mono text-foreground">
            {resolved || <span className="text-muted-foreground italic">(empty)</span>}
          </span>
        </div>
      )}
    </label>
  );
}

function PreviewBubble({
  headerComp,
  headerValue,
  headerMedia,
  bodyText,
  bodyVars,
  bodyNames,
  footerComp,
  buttonsComp,
}: {
  headerComp: TemplateComponent | undefined;
  headerValue: string;
  headerMedia: { kind: "image" | "video" | "document"; link: string; filename?: string } | null;
  bodyText: string;
  bodyVars: string[];
  /** Placeholder names, positionally aligned with `bodyVars`, for a NAMED
   *  template; null for a positional one. */
  bodyNames: string[] | null;
  footerComp: TemplateComponent | undefined;
  buttonsComp: TemplateComponent | undefined;
}) {
  const renderedBody = bodyNames
    ? renderTemplateBodyNamed(
        bodyText,
        bodyNames.map((name, i) => ({ name, text: bodyVars[i] ?? "" })),
      )
    : renderPlaceholders(bodyText, bodyVars);
  const renderedHeader =
    headerComp?.format === "TEXT" && headerComp.text
      ? // A named header substitutes by name; `renderPlaceholders` only knows
        // `{{1}}`, so it left `{{customer_name}}` visible in the preview.
        renderTemplateBodyNamed(renderPlaceholders(headerComp.text, [headerValue]), [
          ...templateNamedPlaceholders(headerComp.text).map((name) => ({
            name,
            text: headerValue,
          })),
        ])
      : null;

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-xs">
      <div className="rounded-md bg-success-bg/50 p-3 ring-1 ring-success-border">
        {/* Header */}
        {headerComp?.format === "TEXT" && renderedHeader && (
          <div className="mb-1 text-sm font-semibold text-foreground">
            {renderedHeader}
          </div>
        )}
        {headerComp && headerComp.format !== "TEXT" && (
          headerMedia ? (
            headerMedia.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaPreviewSrc(headerMedia.link)}
                alt="Header preview"
                className="mb-2 max-h-40 w-full rounded-md object-cover"
              />
            ) : headerMedia.kind === "video" ? (
              <video
                src={headerMediaPreviewSrc(headerMedia.link)}
                className="mb-2 max-h-40 w-full rounded-md"
                controls
                muted
              />
            ) : (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-success-border bg-success-bg/50 px-3 py-2 text-xs text-foreground">
                <FileText className="size-4 shrink-0 text-success-fg" />
                <span className="truncate">{headerMedia.filename ?? "Document"}</span>
              </div>
            )
          ) : (
            <div className="mb-2 flex h-20 items-center justify-center rounded-md border border-dashed border-success-border bg-success-bg/50 text-2xs text-muted-foreground">
              {headerComp.format ?? "MEDIA"} header
            </div>
          )
        )}

        {/* Body */}
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {renderedBody || (
            <span className="text-muted-foreground">No body</span>
          )}
        </div>

        {/* Footer */}
        {footerComp?.text && (
          <div className="mt-2 text-2xs text-muted-foreground">
            {footerComp.text}
          </div>
        )}
      </div>

      {/* Buttons */}
      {buttonsComp?.buttons && buttonsComp.buttons.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {buttonsComp.buttons.map((b, i) => (
            <div
              key={i}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-center text-xs font-medium text-primary"
            >
              {b.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

