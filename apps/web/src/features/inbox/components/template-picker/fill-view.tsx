"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, FileText, Loader2, Send } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { Button } from "@/components/ui/button";
import { HeaderMediaField } from "@/features/templates/components/header-media-field";
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
  resolveFieldTokens,
  type ContactLike,
} from "@ccp/shared/field-tokens";
import { FieldTokenPicker } from "@/features/templates/components/field-token-picker";
import { TokenHighlightInput } from "@/features/templates/components/token-highlight";

import {
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
    header?: string;
    headerMedia?: { kind: "image" | "video" | "document"; link: string; filename?: string };
  }) => Promise<void>;
}) {
  // The DTO carries `components: unknown[]` to keep the boundary loose;
  // narrow once here so the rest of the component sees a real shape.
  const components = (
    Array.isArray(template.components) ? template.components : []
  ) as TemplateComponent[];
  const headerComp = components.find((c) => c.type === "HEADER");
  const footerComp = components.find((c) => c.type === "FOOTER");
  const buttonsComp = components.find((c) => c.type === "BUTTONS");

  const bodyVarCount = countPlaceholders(template.bodyText);
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? countPlaceholders(headerComp.text)
      : 0;
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

  // Reset whenever the template changes — agents pick template A, back out,
  // pick template B; we don't want B's slots prefilled with A's values.
  useEffect(() => {
    setBodyVars(Array.from({ length: bodyVarCount }, () => ""));
    setHeaderVar("");
    setHeaderMedia(null);
    setUploadError(null);
  }, [template.id, bodyVarCount]);

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
      lastInboundAt,
      stageName: contact.stageId
        ? stageCatalog.find((s) => s.id === contact.stageId)?.name ?? null
        : null,
      tagNames: (contact.tagIds ?? [])
        .map((id) => tags.find((t) => t.id === id)?.name)
        .filter((n): n is string => typeof n === "string"),
    }),
    [contact, stageCatalog, tags, lastInboundAt],
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

  const allFilled =
    resolvedBodyVars.every((v) => v.trim().length > 0) &&
    (headerVarCount === 0 || resolvedHeaderVar.trim().length > 0) &&
    (headerMediaKind === null || headerMedia !== null);

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
          body: resolvedBodyVars,
          ...(headerVarCount > 0 ? { header: resolvedHeaderVar } : {}),
          ...(headerMedia ? { headerMedia } : {}),
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
                label={`Body {{${i + 1}}}`}
                value={v}
                resolved={resolvedBodyVars[i] ?? ""}
                onChange={(next) => {
                  setBodyVars((cur) => {
                    const copy = cur.slice();
                    copy[i] = next;
                    return copy;
                  });
                }}
                placeholder={extractExample(headerComp?.example?.body_text?.[0], i)}
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
          <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-2xs text-muted-foreground">
            This template has no variables — it&apos;ll send as-is.
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
          <Check className="mr-1 inline size-3 text-emerald-500" />
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
  footerComp,
  buttonsComp,
}: {
  headerComp: TemplateComponent | undefined;
  headerValue: string;
  headerMedia: { kind: "image" | "video" | "document"; link: string; filename?: string } | null;
  bodyText: string;
  bodyVars: string[];
  footerComp: TemplateComponent | undefined;
  buttonsComp: TemplateComponent | undefined;
}) {
  const renderedBody = renderPlaceholders(bodyText, bodyVars);
  const renderedHeader =
    headerComp?.format === "TEXT" && headerComp.text
      ? renderPlaceholders(headerComp.text, [headerValue])
      : null;

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-xs">
      <div className="rounded-md bg-emerald-500/5 p-3 ring-1 ring-emerald-500/10">
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
                src={headerMedia.link}
                alt="Header preview"
                className="mb-2 max-h-40 w-full rounded-md object-cover"
              />
            ) : headerMedia.kind === "video" ? (
              <video
                src={headerMedia.link}
                className="mb-2 max-h-40 w-full rounded-md"
                controls
                muted
              />
            ) : (
              <div className="mb-2 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-foreground">
                <FileText className="size-4 shrink-0 text-emerald-600" />
                <span className="truncate">{headerMedia.filename ?? "Document"}</span>
              </div>
            )
          ) : (
            <div className="mb-2 flex h-20 items-center justify-center rounded-md border border-dashed border-emerald-500/30 bg-emerald-500/5 text-2xs text-muted-foreground">
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

