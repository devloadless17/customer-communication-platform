"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Phone,
  Plus,
  Reply,
  Send,
  Trash2,
  Type,
  Upload,
  Video,
  X,
  FileText as FileTextIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TemplatePreview } from "@/features/templates/components/template-preview";
import { VariableBindingsEditor } from "@/features/templates/components/variable-bindings-editor";
import { apiFetch } from "@/lib/api/client-fetch";
import type { ContactFieldDefinition } from "@ccp/shared/types";
import type {
  TemplateCategory,
  TemplateComponent,
} from "@ccp/shared/providers/types";
import type { VariableBindings } from "@ccp/shared/template-bindings";
import { cn } from "@ccp/shared/utils";

/**
 * Two-pane template wizard.
 *
 *   Left:  form (name, language, category, header, body, footer, buttons,
 *          variable bindings).
 *   Right: live preview that updates on every keystroke.
 *
 * Meta accepts a fairly tight schema; we mirror its rules in the form so
 * agents don't ping-pong with rejections:
 *
 *   - Name: lowercase letters / digits / underscores, ≤ 512 chars.
 *   - Language: BCP-47 short codes Meta supports (en_US, fr, pt_BR, …).
 *   - Body required, ≤ 1024 chars, placeholders are consecutive {{1}}, {{2}},
 *     …, examples REQUIRED (Meta rejects 132012 otherwise).
 *   - Header optional, TEXT / IMAGE / VIDEO / DOCUMENT, ≤ 60 chars text,
 *     TEXT can carry at most one {{1}}.
 *   - Footer optional, ≤ 60 chars, no placeholders.
 *   - Buttons optional, up to 10. We support quick-reply / URL / phone.
 *
 * On submit we build the components array exactly as Meta expects, attach
 * `example.body_text` / `example.header_text` / `example.header_handle`
 * (when applicable), and POST to /api/team/whatsapp/templates/create.
 */

interface ButtonRow {
  id: string;
  kind: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  text: string;
  url: string; // only used when kind === "URL"
  phone: string; // only used when kind === "PHONE_NUMBER"
}

type HeaderKind = "none" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";

const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "es_MX", label: "Spanish (MX)" },
  { code: "fr", label: "French" },
  { code: "pt_BR", label: "Portuguese (BR)" },
  { code: "de", label: "German" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "tr", label: "Turkish" },
];

const SAMPLE_PLACEHOLDER = ["John", "12345", "Friday at 5pm", "Cairo", "20%"];

export function TemplateForm({
  fieldDefinitions,
  hasAppId,
}: {
  fieldDefinitions: ContactFieldDefinition[];
  hasAppId: boolean;
}) {
  const router = useRouter();
  const softRefresh = useSoftRefresh();

  // ---- Core fields -----
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en_US");
  const [category, setCategory] = useState<TemplateCategory>("utility");

  // ---- Header -----
  const [headerKind, setHeaderKind] = useState<HeaderKind>("none");
  const [headerText, setHeaderText] = useState("");
  const [headerHandle, setHeaderHandle] = useState<string | null>(null);
  const [headerPreviewUrl, setHeaderPreviewUrl] = useState<string | null>(null);
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  // ---- Body / footer -----
  const [body, setBody] = useState("Hi {{1}}, your order {{2}} is on its way.");
  const [footer, setFooter] = useState("");

  // ---- Buttons -----
  const [buttons, setButtons] = useState<ButtonRow[]>([]);

  // ---- Variable bindings (per-recipient personalization) -----
  const [bindings, setBindings] = useState<VariableBindings>({ body: [] });

  // ---- Submit -----
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  const bodyVarCount = useMemo(() => countPlaceholders(body), [body]);
  const headerHasVar = useMemo(
    () => headerKind === "TEXT" && countPlaceholders(headerText) > 0,
    [headerKind, headerText],
  );

  const components = useMemo<TemplateComponent[]>(() => {
    const out: TemplateComponent[] = [];

    if (headerKind === "TEXT" && headerText.trim().length > 0) {
      const headerExample = SAMPLE_PLACEHOLDER[0]!;
      out.push({
        type: "HEADER",
        format: "TEXT",
        text: headerText,
        ...(countPlaceholders(headerText) > 0
          ? { example: { header_text: [headerExample] } }
          : {}),
      });
    } else if (
      (headerKind === "IMAGE" || headerKind === "VIDEO" || headerKind === "DOCUMENT") &&
      headerHandle
    ) {
      out.push({
        type: "HEADER",
        format: headerKind,
        example: { header_handle: [headerHandle] },
      });
    }

    if (body.trim().length > 0) {
      out.push({
        type: "BODY",
        text: body,
        ...(bodyVarCount > 0
          ? { example: { body_text: [exampleBodyValues(bodyVarCount)] } }
          : {}),
      });
    }

    if (footer.trim().length > 0) {
      out.push({ type: "FOOTER", text: footer });
    }

    if (buttons.length > 0) {
      out.push({
        type: "BUTTONS",
        buttons: buttons.map(toMetaButton),
      });
    }

    return out;
  }, [headerKind, headerText, headerHandle, body, bodyVarCount, footer, buttons]);

  const sampleBodyValues = useMemo(() => exampleBodyValues(bodyVarCount), [bodyVarCount]);
  const sampleHeaderValue = headerHasVar ? SAMPLE_PLACEHOLDER[0]! : "";

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------
  const nameValid = /^[a-z0-9_]{1,512}$/.test(name);
  const bodyValid = body.trim().length > 0 && body.length <= 1024;
  const headerValid =
    headerKind === "none" ||
    (headerKind === "TEXT" &&
      headerText.length > 0 &&
      headerText.length <= 60 &&
      countPlaceholders(headerText) <= 1) ||
    (headerKind !== "TEXT" && headerHandle !== null);
  const footerValid = footer.length <= 60 && !/\{\{\d+\}\}/.test(footer);
  const buttonsValid = buttons.every(buttonRowValid);
  const labelsValid =
    bindings.body.every((b) => b.label.trim().length > 0) &&
    (!bindings.header || bindings.header.label.trim().length > 0);

  const canSubmit =
    nameValid && bodyValid && headerValid && footerValid && buttonsValid && labelsValid;

  // -------------------------------------------------------------------------
  // Side effects
  // -------------------------------------------------------------------------
  // Clean up object URL on unmount or when the file changes.
  useEffect(() => {
    return () => {
      if (headerPreviewUrl) URL.revokeObjectURL(headerPreviewUrl);
    };
  }, [headerPreviewUrl]);

  // Reset uploaded handle if we change away from a media header type.
  useEffect(() => {
    if (headerKind === "none" || headerKind === "TEXT") {
      setHeaderHandle(null);
      setHeaderFile(null);
      if (headerPreviewUrl) {
        URL.revokeObjectURL(headerPreviewUrl);
        setHeaderPreviewUrl(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerKind]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  const insertVar = useCallback(() => {
    const next = bodyVarCount + 1;
    const ta = bodyTextareaRef.current;
    const insert = `{{${next}}}`;
    if (ta) {
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      setBody(ta.value.slice(0, start) + insert + ta.value.slice(end));
      // Restore caret after React rerenders.
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + insert.length;
        ta.setSelectionRange(pos, pos);
      });
    } else {
      setBody((cur) => cur + insert);
    }
  }, [bodyVarCount]);

  const onHeaderFileChange = useCallback(
    async (file: File | null) => {
      setHeaderError(null);
      if (!file) return;
      // Local preview right away.
      if (headerPreviewUrl) URL.revokeObjectURL(headerPreviewUrl);
      setHeaderFile(file);
      setHeaderPreviewUrl(URL.createObjectURL(file));
      setHeaderHandle(null);

      // Upload to Meta via our route. Returns a handle we embed in the
      // create payload's example.header_handle.
      setUploadingHeader(true);
      // 120s upload timeout. Without it a stalled connection leaves the
      // form in "Uploading…" forever with no Cancel affordance.
      const abort = new AbortController();
      const timeoutId = window.setTimeout(() => abort.abort(), 120_000);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await apiFetch("/api/team/whatsapp/templates/upload-media", {
          method: "POST",
          body: fd,
          signal: abort.signal,
        });
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
        setHeaderHandle(data.headerHandle);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          setHeaderError("Upload timed out. Try again with a smaller file or a faster connection.");
        } else {
          setHeaderError(err instanceof Error ? err.message : "Upload failed");
        }
        setHeaderHandle(null);
      } finally {
        window.clearTimeout(timeoutId);
        setUploadingHeader(false);
      }
    },
    [headerPreviewUrl],
  );

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/team/whatsapp/templates/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          language,
          category,
          components,
          variableBindings: bindings,
        }),
      });
      const data = (await res.json()) as {
        templateId?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !data.templateId) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      router.push("/templates");
      softRefresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submit failed");
      setSubmitting(false);
    }
  }, [canSubmit, name, language, category, components, bindings, router, softRefresh]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <header className="flex flex-col gap-1">
        <Link
          href="/templates"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to templates
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New template</h1>
        <p className="text-sm text-muted-foreground">
          Submit a new WhatsApp template for review. Meta typically replies
          within a few hours, sometimes a day. You can&apos;t broadcast with a
          template until it&apos;s in the <span className="font-medium">approved</span> state.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ----------------------------- FORM -------------------------------- */}
        <div className="flex flex-col gap-6">
          {/* Basics */}
          <Section
            index={1}
            title="Basics"
            done={nameValid && language.length > 0}
            summary={
              nameValid
                ? `${name} · ${language} · ${category}`
                : undefined
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Name"
                hint="Lowercase letters, digits, underscores. Meta keys the template by this."
                error={
                  name.length > 0 && !nameValid
                    ? "Use lowercase letters, digits and underscores only."
                    : null
                }
              >
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  placeholder="order_confirmation"
                />
              </Field>
              <Field label="Language">
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label} ({l.code})
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="mt-3">
              <Field label="Category" hint="Marketing reaches the most people; utility is for transactional reminders.">
                <div className="flex gap-2">
                  <CategoryPill
                    active={category === "marketing"}
                    onClick={() => setCategory("marketing")}
                  >
                    Marketing
                  </CategoryPill>
                  <CategoryPill
                    active={category === "utility"}
                    onClick={() => setCategory("utility")}
                  >
                    Utility
                  </CategoryPill>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Authentication category templates have a different shape and aren&apos;t supported here yet.
                </p>
              </Field>
            </div>
          </Section>

          {/* Header */}
          <Section index={2} title="Header (optional)" done={headerValid}>
            <div className="flex flex-wrap gap-2">
              <HeaderKindPill icon={<X className="size-3.5" />} active={headerKind === "none"} onClick={() => setHeaderKind("none")}>
                None
              </HeaderKindPill>
              <HeaderKindPill icon={<Type className="size-3.5" />} active={headerKind === "TEXT"} onClick={() => setHeaderKind("TEXT")}>
                Text
              </HeaderKindPill>
              <HeaderKindPill icon={<ImageIcon className="size-3.5" />} active={headerKind === "IMAGE"} onClick={() => setHeaderKind("IMAGE")}>
                Image
              </HeaderKindPill>
              <HeaderKindPill icon={<Video className="size-3.5" />} active={headerKind === "VIDEO"} onClick={() => setHeaderKind("VIDEO")}>
                Video
              </HeaderKindPill>
              <HeaderKindPill icon={<FileTextIcon className="size-3.5" />} active={headerKind === "DOCUMENT"} onClick={() => setHeaderKind("DOCUMENT")}>
                Document
              </HeaderKindPill>
            </div>

            {headerKind === "TEXT" && (
              <div className="mt-3">
                <Field
                  label="Header text"
                  hint="Up to 60 chars. Can include at most one {{1}}."
                  error={
                    headerText.length > 60
                      ? "Header text must be 60 chars or fewer."
                      : countPlaceholders(headerText) > 1
                        ? "Header can include at most one placeholder."
                        : null
                  }
                >
                  <Input
                    value={headerText}
                    onChange={(e) => setHeaderText(e.target.value)}
                    placeholder="Order #{{1}} update"
                    maxLength={80}
                  />
                </Field>
              </div>
            )}

            {(headerKind === "IMAGE" || headerKind === "VIDEO" || headerKind === "DOCUMENT") && (
              <div className="mt-3 flex flex-col gap-2">
                {!hasAppId && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px]">
                    <span className="font-medium text-amber-700 dark:text-amber-300">
                      Meta App ID required.
                    </span>{" "}
                    <span className="text-muted-foreground">
                      Add it in{" "}
                      <Link href="/settings/whatsapp" className="text-primary hover:underline">
                        Settings → WhatsApp
                      </Link>{" "}
                      to upload header media.
                    </span>
                  </div>
                )}
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-4 py-3 text-sm transition-colors",
                    "border-border hover:bg-accent/30",
                    !hasAppId && "pointer-events-none opacity-60",
                  )}
                >
                  <input
                    type="file"
                    className="hidden"
                    accept={
                      headerKind === "IMAGE"
                        ? "image/jpeg,image/png"
                        : headerKind === "VIDEO"
                          ? "video/mp4,video/3gpp"
                          : "application/pdf"
                    }
                    onChange={(e) => onHeaderFileChange(e.target.files?.[0] ?? null)}
                  />
                  {uploadingHeader ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <Upload className="size-4 text-muted-foreground" />
                  )}
                  <div className="flex flex-col">
                    <span className="font-medium">
                      {headerHandle ? "Replace file" : `Upload ${headerKind.toLowerCase()}`}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {headerFile?.name ?? "JPEG/PNG · MP4/3GP · PDF — up to 16 MB"}
                    </span>
                  </div>
                  {headerHandle && (
                    <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                      <Check className="size-3" />
                      Uploaded
                    </span>
                  )}
                </label>
                {headerError && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="wrap-break-word">{headerError}</span>
                  </div>
                )}
              </div>
            )}
          </Section>

          {/* Body */}
          <Section index={3} title="Body" done={bodyValid}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                Up to 1024 chars · {body.length}/1024 · {bodyVarCount} variable{bodyVarCount === 1 ? "" : "s"}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={insertVar} className="h-7 gap-1.5 text-[11px]">
                <Plus className="size-3" />
                Insert {`{{${bodyVarCount + 1}}}`}
              </Button>
            </div>
            <Textarea
              ref={bodyTextareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi {{1}}, your order {{2}} is on its way."
              maxLength={1500}
              className="mt-2 min-h-[140px] font-mono text-[13px]"
            />
            {body.length > 0 && !bodyValid && (
              <p className="mt-1 text-[11px] text-destructive">Body is required and must be 1024 chars or fewer.</p>
            )}
          </Section>

          {/* Footer */}
          <Section index={4} title="Footer (optional)" done={footerValid}>
            <Input
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Reply STOP to opt out"
              maxLength={70}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Up to 60 chars. No variables.
              {footer.length > 60 && (
                <span className="ml-2 text-destructive">{footer.length}/60</span>
              )}
            </p>
          </Section>

          {/* Buttons */}
          <Section index={5} title="Buttons (optional)" done={buttonsValid}>
            <ButtonsEditor buttons={buttons} onChange={setButtons} />
          </Section>

          {/* Bindings */}
          {(bodyVarCount > 0 || headerHasVar) && (
            <Section
              index={6}
              title="Personalize variables"
              done={labelsValid}
              summary={
                labelsValid
                  ? `${(bindings.header ? 1 : 0) + bindings.body.length} configured`
                  : undefined
              }
            >
              <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
                Pull each variable from a contact field at broadcast time, or
                leave it as a manual value the agent fills in once. Defaults
                cover contacts whose field is blank.
              </p>
              <VariableBindingsEditor
                components={components}
                initialBindings={bindings}
                fieldDefinitions={fieldDefinitions}
                onChange={setBindings}
              />
              {!labelsValid && (
                <p className="mt-2 text-[11px] text-destructive">Give every variable a short label.</p>
              )}
            </Section>
          )}

          {submitError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="wrap-break-word">{submitError}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" asChild>
              <Link href="/templates">Cancel</Link>
            </Button>
            <Button type="button" onClick={submit} disabled={!canSubmit || submitting} className="gap-1.5">
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {submitting ? "Submitting…" : "Submit for review"}
            </Button>
          </div>
        </div>

        {/* ----------------------------- PREVIEW ----------------------------- */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Live preview</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="rounded-lg bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.06),_transparent_60%)] p-3">
              <TemplatePreview
                components={components}
                bodyValues={sampleBodyValues}
                headerValue={sampleHeaderValue}
                headerMediaUrl={headerPreviewUrl}
              />
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Variables shown filled with example values. Bound variables will
              pull from each contact at broadcast time.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons editor
// ---------------------------------------------------------------------------

function ButtonsEditor({
  buttons,
  onChange,
}: {
  buttons: ButtonRow[];
  onChange: (next: ButtonRow[]) => void;
}) {
  const addButton = (kind: ButtonRow["kind"]) => {
    if (buttons.length >= 10) return;
    onChange([
      ...buttons,
      { id: cryptoRandomId(), kind, text: "", url: "", phone: "" },
    ]);
  };
  const updateButton = (id: string, patch: Partial<ButtonRow>) => {
    onChange(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };
  const removeButton = (id: string) => onChange(buttons.filter((b) => b.id !== id));

  return (
    <div className="flex flex-col gap-2">
      {buttons.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-[12px] text-muted-foreground">
          No buttons. Add up to 10 — replies, links or phone calls.
        </div>
      ) : (
        buttons.map((b) => (
          <div key={b.id} className="rounded-lg border border-border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <ButtonKindPill
                active={b.kind === "QUICK_REPLY"}
                icon={<Reply className="size-3.5" />}
                onClick={() => updateButton(b.id, { kind: "QUICK_REPLY" })}
              >
                Quick reply
              </ButtonKindPill>
              <ButtonKindPill
                active={b.kind === "URL"}
                icon={<ExternalLink className="size-3.5" />}
                onClick={() => updateButton(b.id, { kind: "URL" })}
              >
                URL
              </ButtonKindPill>
              <ButtonKindPill
                active={b.kind === "PHONE_NUMBER"}
                icon={<Phone className="size-3.5" />}
                onClick={() => updateButton(b.id, { kind: "PHONE_NUMBER" })}
              >
                Phone
              </ButtonKindPill>
              <button
                type="button"
                onClick={() => removeButton(b.id)}
                className="ml-auto inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label="Remove button"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={b.text}
                onChange={(e) => updateButton(b.id, { text: e.target.value })}
                placeholder="Button label (≤ 25 chars)"
                maxLength={30}
              />
              {b.kind === "URL" && (
                <Input
                  value={b.url}
                  onChange={(e) => updateButton(b.id, { url: e.target.value })}
                  placeholder="https://… (Meta opens this URL)"
                />
              )}
              {b.kind === "PHONE_NUMBER" && (
                <Input
                  value={b.phone}
                  onChange={(e) => updateButton(b.id, { phone: e.target.value })}
                  placeholder="+15551234567"
                />
              )}
            </div>
          </div>
        ))
      )}

      {buttons.length < 10 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => addButton("QUICK_REPLY")} className="h-7 gap-1.5 text-[11px]">
            <Plus className="size-3" /> Quick reply
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => addButton("URL")} className="h-7 gap-1.5 text-[11px]">
            <Plus className="size-3" /> URL
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => addButton("PHONE_NUMBER")} className="h-7 gap-1.5 text-[11px]">
            <Plus className="size-3" /> Phone
          </Button>
        </div>
      )}
    </div>
  );
}

function ButtonKindPill({
  active,
  icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function HeaderKindPill({
  active,
  icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function CategoryPill({
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
        "rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Section({
  index,
  title,
  done,
  summary,
  children,
}: {
  index: number;
  title: string;
  done?: boolean;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-3">
        <div
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold",
            done
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-primary/10 text-primary",
          )}
        >
          {done ? <Check className="size-3.5" /> : index}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {summary && <div className="text-[11px] text-muted-foreground">{summary}</div>}
        </div>
        {done && <ChevronRight className="hidden size-3.5 text-muted-foreground sm:block" />}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium">{label}</span>
      {children}
      {hint && !error && <span className="text-[10.5px] text-muted-foreground">{hint}</span>}
      {error && <span className="text-[10.5px] text-destructive">{error}</span>}
    </label>
  );
}

function buttonRowValid(b: ButtonRow): boolean {
  if (b.text.trim().length === 0 || b.text.length > 25) return false;
  if (b.kind === "URL") return /^https?:\/\//.test(b.url.trim());
  if (b.kind === "PHONE_NUMBER") return /^\+?\d{6,15}$/.test(b.phone.trim().replace(/\s/g, ""));
  return true;
}

function toMetaButton(b: ButtonRow): NonNullable<TemplateComponent["buttons"]>[number] {
  if (b.kind === "URL") return { type: "URL", text: b.text, url: b.url };
  if (b.kind === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone };
  return { type: "QUICK_REPLY", text: b.text };
}

function countPlaceholders(text: string): number {
  let max = 0;
  const re = /\{\{(\d+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function exampleBodyValues(count: number): string[] {
  return Array.from({ length: count }, (_, i) => SAMPLE_PLACEHOLDER[i % SAMPLE_PLACEHOLDER.length]!);
}

function cryptoRandomId(): string {
  // Browser crypto.randomUUID is widely supported; tiny fallback for older
  // contexts so a button add never throws.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 12);
}
