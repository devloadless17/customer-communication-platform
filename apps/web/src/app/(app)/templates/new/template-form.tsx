"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Copy,
  MapPin,
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
import {
  CarouselEditor,
  carouselDraftToComponent,
  emptyCarouselDraft,
  type CarouselDraft,
} from "@/features/templates/components/carousel-editor";
import { apiFetch } from "@/lib/api/client-fetch";
import type { ContactFieldDefinition } from "@ccp/shared/types";
import type {
  TemplateCategory,
  TemplateComponent,
} from "@ccp/shared/providers/types";
import type { VariableBindings } from "@ccp/shared/template-bindings";
import { cn } from "@ccp/shared/utils";
// Meta's real field limits, shared with the server-side validator so the
// counter under the textarea and the API's rejection can never disagree.
import {
  LIMITED_TIME_OFFER_LIMITS,
  TEMPLATE_LIMITS,
  TEMPLATE_NAME_PATTERN,
  TEMPLATE_TTL_RULES,
  formatTtlSeconds,
  validateTemplateTtl,
  positionalPlaceholderIndices,
  templateNamedPlaceholders,
  templateReviewWarnings,
  validateTemplateComponents,
} from "@ccp/shared/template-render";
import { TEMPLATE_LANGUAGES } from "@ccp/shared/template-languages";

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
 * (when applicable), and POST to /api/workspace/whatsapp/templates/create.
 */

interface ButtonRow {
  id: string;
  kind: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
  text: string;
  url: string; // only used when kind === "URL"
  phone: string; // only used when kind === "PHONE_NUMBER"
  /**
   * Meta's `example`. Required for a URL whose target ends in a variable (the
   * sample suffix) and for a COPY_CODE button (the sample coupon) — Meta rejects
   * both without it, and the composer used to send neither.
   */
  example: string;
  /**
   * The ORIGINAL Meta button object, kept when editing a synced template so
   * properties this form doesn't model survive the round-trip. Without it, an
   * edit silently STRIPPED `app_deep_link` (a Manager-created deep-link button)
   * — the resubmission was reviewed and approved without its deep link, and an
   * unknown button TYPE was rewritten as quick_reply. Absent on new buttons.
   */
  raw?: Record<string, unknown>;
}

type HeaderKind = "none" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "LOCATION";

/**
 * Which placeholder dialect the author is writing in.
 *
 * Meta stores exactly ONE `parameter_format` per template, so this is a real
 * mode, not a display preference — the two dialects need different `example`
 * shapes (`body_text` vs `body_text_named_params`) and different send payloads.
 * Before this existed the composer only emitted `{{1}}`, but nothing stopped an
 * author typing `{{first_name}}` into the textarea; the server then declared the
 * template NAMED while shipping positional examples, and Meta rejected it with
 * an error that named no field.
 */
type VarFormat = "positional" | "named";

// Meta's full supported-language table, shared so the list can't drift. A
// hand-picked subset silently blocks templates Meta would accept.
const LANGUAGES = TEMPLATE_LANGUAGES;

const SAMPLE_PLACEHOLDER = ["John", "12345", "Friday at 5pm", "Cairo", "20%"];

/**
 * The template being EDITED, when this form is in edit mode.
 *
 * Edit mode exists so nobody has to delete-and-recreate: Meta blocks reusing an
 * APPROVED template's NAME for 30 days after deletion, so the delete+recreate
 * workflow this app used to recommend stranded an operator for a month over a
 * typo.
 */
export interface TemplateEditTarget {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  status: string;
  parameterFormat: "positional" | "named";
  components: TemplateComponent[];
  messageSendTtlSeconds: number | null;
  /** Set when the template came from Meta's Template Library — copy is fixed. */
  libraryTemplateName: string | null;
}

export function TemplateForm({
  fieldDefinitions,
  hasAppId,
  editing = null,
}: {
  fieldDefinitions: ContactFieldDefinition[];
  hasAppId: boolean;
  /** Null = create a new template. Set = edit this one in place. */
  editing?: TemplateEditTarget | null;
}) {
  const router = useRouter();
  // The account scope the templates page stamped on its "New template" link —
  // the new template is created under THAT number's WABA, not silently on the
  // default one. Absent = default (single-account and legacy paths).
  const searchParams = useSearchParams();
  const templateAccountId = searchParams?.get("accountId") ?? null;
  const templateAccountQuery = templateAccountId
    ? `?accountId=${encodeURIComponent(templateAccountId)}`
    : "";
  const softRefresh = useSoftRefresh();

  const initial = useMemo(
    () => (editing ? hydrateFromTemplate(editing) : null),
    [editing],
  );

  // ---- Core fields -----
  // Name and language are IMMUTABLE at Meta — the edit endpoint has no field for
  // either — so in edit mode they are shown, never edited.
  const [name, setName] = useState(editing?.name ?? "");
  const [language, setLanguage] = useState(editing?.language ?? "en_US");
  const [category, setCategory] = useState<TemplateCategory>(
    editing?.category ?? "utility",
  );

  // ---- Header -----
  const [headerKind, setHeaderKind] = useState<HeaderKind>(initial?.headerKind ?? "none");
  const [headerText, setHeaderText] = useState(initial?.headerText ?? "");
  const [headerHandle, setHeaderHandle] = useState<string | null>(null);
  const [headerPreviewUrl, setHeaderPreviewUrl] = useState<string | null>(null);
  const [headerFile, setHeaderFile] = useState<File | null>(null);
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  // ---- Body / footer -----
  const [varFormat, setVarFormat] = useState<VarFormat>(
    editing?.parameterFormat ?? "positional",
  );
  const [body, setBody] = useState(
    initial?.body ?? "Hi {{1}}, your order {{2}} is on its way.",
  );
  const [footer, setFooter] = useState(initial?.footer ?? "");
  // ---- Limited-time offer (marketing only) -----
  // The template declares the offer HEADING; the expiry instant is per-send.
  const [offerHeading, setOfferHeading] = useState(initial?.offerHeading ?? "");
  const [offerEnabled, setOfferEnabled] = useState(initial?.offerHeading !== undefined);
  // ---- Carousel (marketing only) -----
  const [carousel, setCarousel] = useState<CarouselDraft>(
    () => initial?.carousel ?? emptyCarouselDraft(),
  );
  /**
   * Author-supplied example value per variable, keyed by `{{1}}` index or by
   * name. Meta REVIEWS these — a reviewer seeing "John" where an order number
   * belongs is a common rejection — so they are editable rather than silently
   * generated. Seeded from the sample list so the zero-effort path still works.
   */
  const [examples, setExamples] = useState<Record<string, string>>(
    initial?.examples ?? {},
  );
  /** Meta's `message_send_ttl_seconds`; blank = Meta's per-category default. */
  const [ttlSeconds, setTtlSeconds] = useState(
    editing?.messageSendTtlSeconds != null ? String(editing.messageSendTtlSeconds) : "",
  );

  // ---- Buttons -----
  const [buttons, setButtons] = useState<ButtonRow[]>(initial?.buttons ?? []);

  // ---- Variable bindings (per-recipient personalization) -----
  const [bindings, setBindings] = useState<VariableBindings>({ body: [] });

  // ---- Submit -----
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  const isNamed = varFormat === "named";
  /** Body variable KEYS in order: `["1","2"]` or `["first_name","order_id"]`. */
  const bodyVarKeys = useMemo<string[]>(
    () =>
      isNamed
        ? templateNamedPlaceholders(body)
        : Array.from(
            { length: Math.max(0, ...positionalPlaceholderIndices(body)) },
            (_, i) => String(i + 1),
          ),
    [isNamed, body],
  );
  const bodyVarCount = bodyVarKeys.length;
  const headerVarKeys = useMemo<string[]>(
    () =>
      headerKind !== "TEXT"
        ? []
        : isNamed
          ? templateNamedPlaceholders(headerText)
          : [...new Set(positionalPlaceholderIndices(headerText))].map(String),
    [headerKind, isNamed, headerText],
  );
  const headerHasVar = headerVarKeys.length > 0;

  /**
   * The example for a variable: what the author typed, else a sample.
   *
   * Keys are NAMESPACED by component. A positional header's variable is `{{1}}`
   * and so is the first body variable — sharing one keyspace meant typing a
   * header example silently overwrote the body's, and both shipped to Meta with
   * the same value.
   */
  const exampleKey = useCallback(
    (slot: "h" | "b", key: string) => `${slot}:${key}`,
    [],
  );
  const exampleFor = useCallback(
    (slot: "h" | "b", key: string, i: number) =>
      examples[`${slot}:${key}`]?.trim() ||
      SAMPLE_PLACEHOLDER[i % SAMPLE_PLACEHOLDER.length]!,
    [examples],
  );

  const components = useMemo<TemplateComponent[]>(() => {
    const out: TemplateComponent[] = [];

    if (headerKind === "LOCATION") {
      // A location header is declared with NO parameters; the pin is supplied
      // per-message at send time.
      out.push({ type: "HEADER", format: "LOCATION" });
    } else if (headerKind === "TEXT" && headerText.trim().length > 0) {
      const key = headerVarKeys[0];
      out.push({
        type: "HEADER",
        format: "TEXT",
        text: headerText,
        ...(key
          ? {
              example: isNamed
                ? {
                    header_text_named_params: [
                      { param_name: key, example: exampleFor("h", key, 0) },
                    ],
                  }
                : { header_text: [exampleFor("h", key, 0)] },
            }
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
          ? {
              example: isNamed
                ? {
                    body_text_named_params: bodyVarKeys.map((k, i) => ({
                      param_name: k,
                      example: exampleFor("b", k, i),
                    })),
                  }
                : // Positional examples are an array-of-arrays: one inner array
                  // per example set.
                  { body_text: [bodyVarKeys.map((k, i) => exampleFor("b", k, i))] },
            }
          : {}),
      });
    }

    if (footer.trim().length > 0) {
      out.push({ type: "FOOTER", text: footer });
    }

    // Countdown offer. `has_expiration` is what makes WhatsApp render the live
    // timer; without it the card shows the heading and code only.
    if (offerEnabled && category === "marketing") {
      out.push({
        type: "LIMITED_TIME_OFFER",
        limited_time_offer: { text: offerHeading, has_expiration: true },
      });
    }

    if (buttons.length > 0) {
      out.push({
        type: "BUTTONS",
        buttons: buttons.map(toMetaButton),
      });
    }

    // Carousel LAST, matching Meta's example ordering (body, then cards).
    if (carousel.enabled && category === "marketing") {
      out.push(carouselDraftToComponent(carousel) as TemplateComponent);
    }

    return out;
  }, [
    headerKind,
    headerText,
    headerHandle,
    headerVarKeys,
    body,
    bodyVarKeys,
    bodyVarCount,
    isNamed,
    exampleFor,
    footer,
    offerEnabled,
    offerHeading,
    category,
    buttons,
    carousel,
  ]);

  const sampleBodyValues = useMemo(
    () => bodyVarKeys.map((k, i) => exampleFor("b", k, i)),
    [bodyVarKeys, exampleFor],
  );
  const sampleHeaderValue = headerVarKeys[0] ? exampleFor("h", headerVarKeys[0], 0) : "";

  // -------------------------------------------------------------------------
  // Validation
  //
  // The SHARED validator is the authority, so the errors shown here and the
  // rejection the API returns are literally the same rules — the form used to
  // carry its own looser copy and an author could pass every field here and
  // still be rejected on submit.
  // -------------------------------------------------------------------------
  const issues = useMemo(
    () => validateTemplateComponents(name, components, { category }),
    [name, components, category],
  );
  const issuesFor = useCallback(
    (field: string) => issues.filter((i) => i.field === field).map((i) => i.message),
    [issues],
  );
  // Advisory review-risk patterns (dangling parameters, invalid {{…}} tokens,
  // mismatched braces). Meta's own presets break some of them, so these warn —
  // amber, never part of `canSubmit` — rather than block.
  const reviewWarnings = useMemo(() => templateReviewWarnings(components), [components]);
  const warningsFor = useCallback(
    (field: string) => reviewWarnings.filter((i) => i.field === field).map((i) => i.message),
    [reviewWarnings],
  );

  // Meta refuses to change an approved template's category (it may recategorize
  // one itself, or you request a review) — so the picker is disabled rather than
  // letting the author submit something guaranteed to 409.
  const categoryLocked = editing?.status === "approved";

  // TTL is judged against the CATEGORY — the ranges differ and don't overlap at
  // the low end, so the same number can be valid for utility and invalid for
  // marketing. Blank means "Meta's default", which is never materialized.
  const ttlRules = TEMPLATE_TTL_RULES[category];
  const ttlError = ttlSeconds.trim()
    ? Number.isInteger(Number(ttlSeconds.trim()))
      ? validateTemplateTtl(category, Number(ttlSeconds.trim()))
      : "Enter a whole number of seconds."
    : null;
  const ttlHint =
    `${formatTtlSeconds(ttlRules.min)}–${formatTtlSeconds(ttlRules.max)} for a ` +
    `${category} template` +
    (category === "marketing" ? "" : ", or -1 for 30 days") +
    `. Blank uses Meta's default (${formatTtlSeconds(ttlRules.defaultSeconds)}).` +
    // Meta's TTL compatibility table: authentication and utility TTLs apply to
    // Cloud API sends, but a MARKETING TTL only takes effect on the Marketing
    // Messages API, which we don't send through. Saying so beats letting an
    // operator set a value and quietly get Meta's default.
    (category === "marketing"
      ? " Note: Meta applies a custom marketing TTL only to Marketing Messages" +
        " API sends, so it has no effect on messages sent from here yet."
      : "");
  const nameValid = TEMPLATE_NAME_PATTERN.test(name);
  const bodyValid = body.trim().length > 0 && issuesFor("body").length === 0;
  const headerValid =
    (headerKind === "none" ||
      headerKind === "LOCATION" ||
      (headerKind === "TEXT" && headerText.trim().length > 0) ||
      (headerKind !== "TEXT" && headerHandle !== null)) &&
    issuesFor("header").length === 0;
  const footerValid = issuesFor("footer").length === 0;
  // Countdown offers are a MARKETING-only shape, so the section only exists
  // there — and the numbered steps after it shift by one when it does.
  const offerSectionVisible = category === "marketing";
  const offerValid = issuesFor("limited_time_offer").length === 0;
  const buttonsValid = issuesFor("buttons").length === 0;
  // Only the bindings the body/header actually still need. Removing every
  // {{n}} unmounts the personalize section but leaves the old entries in
  // `bindings.body`; validating/submitting the raw state would keep Submit
  // disabled on stale empty-label rows with no visible error, and would
  // persist orphaned bindings. Slice to the effective count instead.
  const effBindings = useMemo<VariableBindings>(
    () => ({
      body: bindings.body.slice(0, bodyVarCount),
      ...(headerHasVar && bindings.header ? { header: bindings.header } : {}),
    }),
    [bindings, bodyVarCount, headerHasVar],
  );
  const labelsValid =
    effBindings.body.every((b) => b.label.trim().length > 0) &&
    (!effBindings.header || effBindings.header.label.trim().length > 0);

  // Body is required and `issues` never reports "missing body" (an absent
  // component has nothing to measure), so it is checked separately.
  const canSubmit =
    nameValid &&
    body.trim().length > 0 &&
    issues.length === 0 &&
    !ttlError &&
    headerValid &&
    labelsValid;

  // -------------------------------------------------------------------------
  // Side effects
  // -------------------------------------------------------------------------
  // Clean up object URL on unmount or when the file changes.
  useEffect(() => {
    return () => {
      if (headerPreviewUrl) URL.revokeObjectURL(headerPreviewUrl);
    };
  }, [headerPreviewUrl]);

  // Reset the uploaded handle whenever the header TYPE changes. A handle
  // uploaded for IMAGE is invalid for VIDEO/DOCUMENT (Meta rejects the
  // mismatch), so keeping it across a media→media switch showed a false
  // "Uploaded" badge and let the form submit a video with an image's handle.
  // (No-op on mount / for the create form, where nothing is uploaded yet.)
  useEffect(() => {
    setHeaderHandle(null);
    setHeaderFile(null);
    if (headerPreviewUrl) {
      URL.revokeObjectURL(headerPreviewUrl);
      setHeaderPreviewUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerKind]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  const insertVar = useCallback(() => {
    // Numbered variables must run 1..N with no gaps, so the next one is always
    // max+1. Named ones only have to be unique.
    const insert = isNamed
      ? `{{variable_${bodyVarCount + 1}}}`
      : `{{${bodyVarCount + 1}}}`;
    const ta = bodyTextareaRef.current;
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
  }, [isNamed, bodyVarCount]);

  /**
   * Switching dialect rewrites the placeholders already typed rather than
   * leaving a mix behind. A mixed body cannot be expressed under Meta's single
   * `parameter_format`, so silently allowing the toggle to strand `{{1}}` next to
   * `{{order_id}}` would just move the rejection to submit time.
   */
  const changeVarFormat = useCallback(
    (next: VarFormat) => {
      if (next === varFormat) return;
      const rewrite = (text: string) =>
        next === "named"
          ? text.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => `{{variable_${n}}}`)
          : (() => {
              let i = 0;
              const seen = new Map<string, number>();
              return text.replace(
                /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
                (_m, nm: string) => {
                  let idx = seen.get(nm);
                  if (idx === undefined) {
                    i += 1;
                    idx = i;
                    seen.set(nm, idx);
                  }
                  return `{{${idx}}}`;
                },
              );
            })();
      setBody(rewrite);
      setHeaderText(rewrite);
      // Example values are keyed by the OLD variable keys, so they no longer
      // address anything. Clearing beats silently mismatching them.
      setExamples({});
      setVarFormat(next);
    },
    [varFormat],
  );

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
        // On an EDIT, name the template instead of the account: the asset must
        // upload through the app that owns THAT template's WABA, and the server
        // reads it from the row rather than trusting a query param a link is
        // free to drop (this one used to be dropped by the Edit link).
        const uploadQuery = editing
          ? `?templateId=${encodeURIComponent(editing.id)}`
          : templateAccountQuery;
        const res = await apiFetch(`/api/workspace/whatsapp/templates/upload-media${uploadQuery}`, {
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
    [headerPreviewUrl, templateAccountQuery, editing],
  );

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      // Edit targets the template node and carries ONLY what Meta lets you
      // change; name and language have no field on that endpoint at all.
      // `components` REPLACES the whole array, which is why the full set is sent.
      const res = await apiFetch(
        editing
          ? `/api/workspace/whatsapp/templates/${editing.id}/edit`
          : `/api/workspace/whatsapp/templates/create${templateAccountQuery}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            editing
              ? {
                  // Meta refuses a category change on an APPROVED template, so
                  // don't even send it — an unchanged value would still trip it.
                  ...(categoryLocked ? {} : { category }),
                  // A Library template's copy is Meta's and immutable.
                  ...(editing.libraryTemplateName ? {} : { components }),
                  ...(ttlSeconds.trim()
                    ? { messageSendTtlSeconds: Number(ttlSeconds) }
                    : {}),
                }
              : {
                  name,
                  language,
                  category,
                  components,
                  variableBindings: effBindings,
                  // Omitted when blank so Meta applies its own per-category
                  // default rather than us pinning a number nobody chose.
                  ...(ttlSeconds.trim()
                    ? { messageSendTtlSeconds: Number(ttlSeconds) }
                    : {}),
                },
          ),
        },
      );
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
  }, [
    canSubmit,
    editing,
    categoryLocked,
    name,
    language,
    category,
    components,
    effBindings,
    ttlSeconds,
    router,
    softRefresh,
    templateAccountQuery,
  ]);

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
        <h1 className="text-2xl font-semibold tracking-tight">
          {editing ? `Edit “${editing.name}”` : "New template"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {editing ? (
            <>
              Editing keeps the template&apos;s name and history. It goes back
              through review and is re-approved unless review fails — unlike
              deleting and recreating, which would block reusing the name{" "}
              <span className="font-medium">for 30 days</span>.
            </>
          ) : (
            <>
              Submit a new WhatsApp template for review. Meta typically replies
              within a few hours, sometimes a day. You can&apos;t broadcast with a
              template until it&apos;s in the{" "}
              <span className="font-medium">approved</span> state.
            </>
          )}
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
                  // Meta's edit endpoint has no field for the name — changing it
                  // would mean a new template.
                  disabled={Boolean(editing)}
                />
              </Field>
              <Field label="Language">
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  // Immutable for the same reason as the name.
                  disabled={Boolean(editing)}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
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
                    disabled={categoryLocked}
                    onClick={() => setCategory("marketing")}
                  >
                    Marketing
                  </CategoryPill>
                  <CategoryPill
                    active={category === "utility"}
                    disabled={categoryLocked}
                    onClick={() => setCategory("utility")}
                  >
                    Utility
                  </CategoryPill>
                </div>
                {categoryLocked && (
                  <p className="mt-1 text-2xs text-muted-foreground">
                    An approved template&apos;s category can&apos;t be changed. Meta may
                    recategorize it itself, or you can request a review in WhatsApp
                    Manager.
                  </p>
                )}
                <p className="mt-1 text-2xs text-muted-foreground">
                  Authentication templates must come from Meta&apos;s Template
                  Library (they require a one-time-password button and forbid
                  URLs, media and emoji), so they aren&apos;t authored here.
                  Create one in WhatsApp Manager and it syncs in ready to send.
                </p>
              </Field>
            </div>

            <div className="mt-3">
              <Field
                label="Time-to-live (optional)"
                hint={ttlHint}
                error={ttlError}
              >
                <Input
                  value={ttlSeconds}
                  // `-` is allowed through so Meta's documented `-1` (= 30 days,
                  // authentication + utility only) can be typed; the shared
                  // validator judges the result.
                  onChange={(e) => setTtlSeconds(e.target.value.replace(/[^\d-]/g, ""))}
                  inputMode="numeric"
                  placeholder={`e.g. ${TEMPLATE_TTL_RULES[category].min}`}
                  className="max-w-45"
                />
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
              {/* Meta allows a map header only on utility/marketing templates —
                  the shared validator enforces it, this just doesn't offer it. */}
              {category !== "authentication" && (
                <HeaderKindPill
                  icon={<MapPin className="size-3.5" />}
                  active={headerKind === "LOCATION"}
                  onClick={() => setHeaderKind("LOCATION")}
                >
                  Location
                </HeaderKindPill>
              )}
            </div>

            {headerKind === "LOCATION" && (
              <p className="mt-3 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-2xs leading-relaxed text-muted-foreground">
                A map card appears above the message. The template carries no
                coordinates — the pin (latitude, longitude, place name, address)
                is supplied per message when you send or broadcast it.
              </p>
            )}

            {headerKind === "TEXT" && (
              <div className="mt-3">
                <Field
                  label="Header text"
                  hint="Up to 60 chars. Can include at most one {{1}}."
                  error={issuesFor("header")[0] ?? null}
                >
                  <Input
                    value={headerText}
                    onChange={(e) => setHeaderText(e.target.value)}
                    placeholder="Order #{{1}} update"
                    maxLength={TEMPLATE_LIMITS.headerMaxLength}
                  />
                </Field>
                {warningsFor("header").map((m) => (
                  <p key={m} className="mt-1 text-2xs text-warning-fg">
                    {m}
                  </p>
                ))}
              </div>
            )}

            {(headerKind === "IMAGE" || headerKind === "VIDEO" || headerKind === "DOCUMENT") && (
              <div className="mt-3 flex flex-col gap-2">
                {!hasAppId && (
                  <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs">
                    <span className="font-medium text-warning-fg">
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
                    <span className="text-2xs text-muted-foreground">
                      {headerFile?.name ?? "JPEG/PNG · MP4/3GP · PDF — up to 16 MB"}
                    </span>
                  </div>
                  {headerHandle && (
                    <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-3xs font-medium text-success-fg">
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
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-2xs text-muted-foreground">Variable style</span>
              <VarFormatPill
                active={!isNamed}
                disabled={Boolean(editing)}
                onClick={() => changeVarFormat("positional")}
              >
                Numbered {"{{1}}"}
              </VarFormatPill>
              <VarFormatPill
                active={isNamed}
                disabled={Boolean(editing)}
                onClick={() => changeVarFormat("named")}
              >
                Named {"{{order_id}}"}
              </VarFormatPill>
            </div>
            <p className="mb-2 text-2xs leading-relaxed text-muted-foreground">
              {editing
                ? "Meta stores one variable style per template and an edit can't change it. Create a new template to switch styles."
                : "Meta stores one style per template — switching rewrites the variables you've already typed. Named variables make long templates easier to fill in correctly."}
            </p>

            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-muted-foreground">
                Up to {TEMPLATE_LIMITS.bodyMaxLength} chars ·{" "}
                <span
                  className={cn(
                    body.length > TEMPLATE_LIMITS.bodyMaxLength && "font-medium text-destructive",
                  )}
                >
                  {body.length}/{TEMPLATE_LIMITS.bodyMaxLength}
                </span>{" "}
                · {bodyVarCount} variable{bodyVarCount === 1 ? "" : "s"}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={insertVar} className="h-7 gap-1.5 text-2xs">
                <Plus className="size-3" />
                Insert {isNamed ? `{{variable_${bodyVarCount + 1}}}` : `{{${bodyVarCount + 1}}}`}
              </Button>
            </div>
            <Textarea
              ref={bodyTextareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                isNamed
                  ? "Hi {{first_name}}, your order {{order_number}} is on its way."
                  : "Hi {{1}}, your order {{2}} is on its way."
              }
              maxLength={TEMPLATE_LIMITS.bodyMaxLength}
              className="mt-2 min-h-35 font-mono text-[13px]"
            />
            {body.trim().length === 0 && (
              <p className="mt-1 text-2xs text-destructive">Body is required.</p>
            )}
            {issuesFor("body").map((m) => (
              <p key={m} className="mt-1 text-2xs text-destructive">
                {m}
              </p>
            ))}
            {warningsFor("body").map((m) => (
              <p key={m} className="mt-1 text-2xs text-warning-fg">
                {m}
              </p>
            ))}

            {/* Example values. Meta REVIEWS these — a reviewer who sees "John"
                where an order number belongs is a common rejection — so they are
                the author's to write, not ours to generate. */}
            {(bodyVarCount > 0 || headerHasVar) && (
              <div className="mt-4 rounded-lg border border-border bg-muted/20 p-3">
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Example values
                </div>
                <p className="mb-2 text-2xs leading-relaxed text-muted-foreground">
                  Meta&apos;s reviewers read these to judge what the template is
                  for. Use realistic samples — they are never sent to customers.
                </p>
                <div className="flex flex-col gap-2">
                  {headerVarKeys.map((k) => (
                    <ExampleField
                      key={`h:${k}`}
                      label={`Header {{${k}}}`}
                      value={examples[exampleKey("h", k)] ?? ""}
                      placeholder={exampleFor("h", k, 0)}
                      onChange={(v) =>
                        setExamples((cur) => ({ ...cur, [exampleKey("h", k)]: v }))
                      }
                    />
                  ))}
                  {bodyVarKeys.map((k, i) => (
                    <ExampleField
                      key={`b:${k}`}
                      label={`Body {{${k}}}`}
                      value={examples[exampleKey("b", k)] ?? ""}
                      placeholder={exampleFor("b", k, i)}
                      onChange={(v) =>
                        setExamples((cur) => ({ ...cur, [exampleKey("b", k)]: v }))
                      }
                    />
                  ))}
                </div>
              </div>
            )}
          </Section>

          {/* Footer */}
          <Section index={4} title="Footer (optional)" done={footerValid}>
            <Input
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Reply STOP to opt out"
              maxLength={TEMPLATE_LIMITS.footerMaxLength}
            />
            {issuesFor("footer")[0] && (
              <p className="mt-1 text-2xs text-destructive">{issuesFor("footer")[0]}</p>
            )}
            <p className="mt-1 text-2xs text-muted-foreground">
              Up to {TEMPLATE_LIMITS.footerMaxLength} chars. No variables.{" "}
              <span
                className={cn(
                  footer.length > TEMPLATE_LIMITS.footerMaxLength && "text-destructive",
                )}
              >
                {footer.length}/{TEMPLATE_LIMITS.footerMaxLength}
              </span>
            </p>
          </Section>

          {/* Limited-time offer (marketing only) */}
          {offerSectionVisible && (
            <Section
              index={5}
              title="Limited-time offer (optional)"
              done={offerEnabled && offerValid}
              summary={offerEnabled ? offerHeading || undefined : undefined}
            >
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={offerEnabled}
                  onChange={(e) => setOfferEnabled(e.target.checked)}
                  className="mt-0.5 size-3.5 accent-primary"
                />
                <span className="text-xs leading-relaxed text-muted-foreground">
                  Show a live countdown above the buttons. WhatsApp counts down to
                  an expiry time you set on each send, so one template covers every
                  campaign.
                </span>
              </label>
              {offerEnabled && (
                <div className="mt-3">
                  <Input
                    value={offerHeading}
                    onChange={(e) => setOfferHeading(e.target.value)}
                    placeholder="Expiring offer!"
                    maxLength={LIMITED_TIME_OFFER_LIMITS.offerTextMaxLength}
                  />
                  {issuesFor("limited_time_offer").map((m) => (
                    <p key={m} className="mt-1 text-2xs text-destructive">
                      {m}
                    </p>
                  ))}
                  <p className="mt-1 text-2xs text-muted-foreground">
                    Up to {LIMITED_TIME_OFFER_LIMITS.offerTextMaxLength} chars, no
                    variables. These templates take an image or video header, no
                    footer, and a body up to{" "}
                    {LIMITED_TIME_OFFER_LIMITS.bodyMaxLength} characters.{" "}
                    <span
                      className={cn(
                        offerHeading.length >
                          LIMITED_TIME_OFFER_LIMITS.offerTextMaxLength &&
                          "text-destructive",
                      )}
                    >
                      {offerHeading.length}/
                      {LIMITED_TIME_OFFER_LIMITS.offerTextMaxLength}
                    </span>
                  </p>
                </div>
              )}
            </Section>
          )}

          {/* Buttons */}
          <Section index={offerSectionVisible ? 6 : 5} title="Buttons (optional)" done={buttonsValid}>
            <ButtonsEditor buttons={buttons} onChange={setButtons} />
            {issuesFor("buttons").map((m) => (
              <p key={m} className="mt-1 text-2xs text-destructive">
                {m}
              </p>
            ))}
            {buttons.length > TEMPLATE_LIMITS.buttonsBeforeSeeAllOptions && (
              <p className="mt-1 text-2xs text-muted-foreground">
                With more than {TEMPLATE_LIMITS.buttonsBeforeSeeAllOptions} buttons WhatsApp
                shows the first two and hides the rest behind &ldquo;See all
                options&rdquo;. Templates with 4+ buttons, or a quick reply mixed with
                other types, can&apos;t be opened on WhatsApp Desktop.
              </p>
            )}
          </Section>

          {/* Carousel (marketing only) */}
          {offerSectionVisible && (
            <Section
              index={7}
              title="Product cards (optional)"
              done={carousel.enabled && issuesFor("carousel").length === 0}
              summary={carousel.enabled ? `${carousel.cards.length} cards` : undefined}
            >
              <CarouselEditor
                draft={carousel}
                onChange={setCarousel}
                issues={issuesFor("carousel")}
              />
            </Section>
          )}

          {/* Bindings */}
          {(bodyVarCount > 0 || headerHasVar) && (
            <Section
              index={offerSectionVisible ? 8 : 6}
              title="Personalize variables"
              done={labelsValid}
              summary={
                labelsValid
                  ? `${(bindings.header ? 1 : 0) + bindings.body.length} configured`
                  : undefined
              }
            >
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                Pull each variable from a contact field at broadcast time, or
                leave it as a manual value the agent fills in once. Defaults
                cover contacts whose field is blank.
              </p>
              <VariableBindingsEditor
                components={components}
                parameterFormat={varFormat}
                initialBindings={bindings}
                fieldDefinitions={fieldDefinitions}
                onChange={setBindings}
              />
              {!labelsValid && (
                <p className="mt-2 text-2xs text-destructive">Give every variable a short label.</p>
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
              {submitting
                ? editing
                  ? "Saving…"
                  : "Submitting…"
                : editing
                  ? "Save and resubmit"
                  : "Submit for review"}
            </Button>
          </div>
        </div>

        {/* ----------------------------- PREVIEW ----------------------------- */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Live preview</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="rounded-lg bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.06),transparent_60%)] p-3">
              <TemplatePreview
                components={components}
                bodyValues={sampleBodyValues}
                headerValue={sampleHeaderValue}
                headerMediaUrl={headerPreviewUrl}
                bodyNames={isNamed ? bodyVarKeys : null}
                headerName={isNamed ? headerVarKeys[0] ?? null : null}
              />
            </div>
            <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
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
    if (buttons.length >= TEMPLATE_LIMITS.maxButtons) return;
    onChange([
      ...buttons,
      { id: cryptoRandomId(), kind, text: "", url: "", phone: "", example: "" },
    ]);
  };
  const updateButton = (id: string, patch: Partial<ButtonRow>) => {
    onChange(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };
  const removeButton = (id: string) => onChange(buttons.filter((b) => b.id !== id));

  return (
    <div className="flex flex-col gap-2">
      {buttons.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
          No buttons. Add up to {TEMPLATE_LIMITS.maxButtons} — quick replies,
          links, a phone call or a coupon code.
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
              <ButtonKindPill
                active={b.kind === "COPY_CODE"}
                icon={<Copy className="size-3.5" />}
                onClick={() => updateButton(b.id, { kind: "COPY_CODE" })}
              >
                Copy code
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
              {/* A copy-code button has no label — Meta renders its own. */}
              {b.kind !== "COPY_CODE" && (
                <Input
                  value={b.text}
                  onChange={(e) => updateButton(b.id, { text: e.target.value })}
                  placeholder={`Button label (\u2264 ${TEMPLATE_LIMITS.buttonTextMaxLength} chars)`}
                  maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
                />
              )}
              {b.kind === "URL" && (
                <Input
                  value={b.url}
                  onChange={(e) => updateButton(b.id, { url: e.target.value })}
                  placeholder="https://shop.com/order/{{1}}"
                  maxLength={TEMPLATE_LIMITS.urlMaxLength}
                />
              )}
              {b.kind === "COPY_CODE" && (
                <Input
                  value={b.example}
                  onChange={(e) => updateButton(b.id, { example: e.target.value })}
                  placeholder={`Sample code (\u2264 ${TEMPLATE_LIMITS.copyCodeExampleMaxLength} chars)`}
                  maxLength={TEMPLATE_LIMITS.copyCodeExampleMaxLength}
                />
              )}
              {b.kind === "PHONE_NUMBER" && (
                <Input
                  value={b.phone}
                  onChange={(e) => updateButton(b.id, { phone: e.target.value })}
                  placeholder="+15551234567"
                  maxLength={TEMPLATE_LIMITS.phoneNumberMaxLength}
                />
              )}
            </div>
            {/* Meta substitutes a URL variable as a SUFFIX and requires a sample
                to review it. Without this field a link like
                `https://shop.com/{{1}}` was submitted with no example and
                rejected — the composer offered no way to supply one. */}
            {b.kind === "URL" && /\{\{\s*[A-Za-z0-9_]+\s*\}\}/.test(b.url) && (
              <div className="mt-2">
                <Input
                  value={b.example}
                  onChange={(e) => updateButton(b.id, { example: e.target.value })}
                  placeholder="Example value for the variable, e.g. summer2023"
                />
                <p className="mt-1 text-2xs text-muted-foreground">
                  The variable must be the LAST thing in the URL. At send time the
                  value is appended — percent-encode spaces and special
                  characters (a space becomes %20).
                </p>
              </div>
            )}
          </div>
        ))
      )}

      {buttons.length < TEMPLATE_LIMITS.maxButtons && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => addButton("QUICK_REPLY")} className="h-7 gap-1.5 text-2xs">
            <Plus className="size-3" /> Quick reply
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => addButton("URL")} className="h-7 gap-1.5 text-2xs">
            <Plus className="size-3" /> URL
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => addButton("PHONE_NUMBER")} className="h-7 gap-1.5 text-2xs">
            <Plus className="size-3" /> Phone
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => addButton("COPY_CODE")} className="h-7 gap-1.5 text-2xs">
            <Plus className="size-3" /> Copy code
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
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium transition-colors",
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
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
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
  disabled = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
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
              ? "bg-success-bg text-success-fg"
              : "bg-primary/10 text-primary",
          )}
        >
          {done ? <Check className="size-3.5" /> : index}
        </div>
        <div className="flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {summary && <div className="text-2xs text-muted-foreground">{summary}</div>}
        </div>
        {done && <ChevronRight className="hidden size-3.5 text-muted-foreground sm:block" />}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

/**
 * Pill for the numbered/named variable-style toggle. Separate from
 * `CategoryPill` only because the two carry different weights in the layout;
 * behaviour is identical.
 */
function VarFormatPill({
  active,
  onClick,
  disabled = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-1 font-mono text-2xs transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent/40",
      )}
    >
      {children}
    </button>
  );
}

/** One reviewer-facing sample value for a variable. */
function ExampleField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-28 shrink-0 font-mono text-2xs text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-xs"
      />
    </label>
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
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && !error && <span className="text-[10.5px] text-muted-foreground">{hint}</span>}
      {error && <span className="text-[10.5px] text-destructive">{error}</span>}
    </label>
  );
}

function toMetaButton(b: ButtonRow): NonNullable<TemplateComponent["buttons"]>[number] {
  // Properties this form doesn't model (`app_deep_link`, flow configs, …),
  // carried through verbatim so an edit can't strip them. The fields the form
  // DOES edit are re-derived below and override anything stale in the raw copy.
  const {
    type: rawType,
    text: _text,
    url: _url,
    phone_number: _phone,
    example: _example,
    ...passthrough
  } = (b.raw ?? {}) as Record<string, unknown>;

  if (b.kind === "URL") {
    // `example` is REQUIRED once the URL ends in a variable — Meta substitutes a
    // suffix, and rejects the template if it has no sample to review. Omitted
    // for a static URL, where an example would itself be invalid.
    const hasVar = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/.test(b.url);
    return {
      ...passthrough,
      type: "URL",
      text: b.text,
      url: b.url,
      ...(hasVar && b.example.trim() ? { example: [b.example.trim()] } : {}),
    };
  }
  if (b.kind === "PHONE_NUMBER") {
    return { ...passthrough, type: "PHONE_NUMBER", text: b.text, phone_number: b.phone };
  }
  // A copy-code button has NO label — it is defined solely by the sample code
  // Meta puts on the recipient's clipboard.
  if (b.kind === "COPY_CODE") {
    return { ...passthrough, type: "COPY_CODE", example: b.example.trim() };
  }
  // A button type this form doesn't know keeps its ORIGINAL type on the way
  // out (only the label is editable here) — rewriting it as quick_reply was a
  // silent mutation of a Meta-approved component.
  const keepType =
    typeof rawType === "string" && rawType.toUpperCase() !== "QUICK_REPLY"
      ? rawType
      : "QUICK_REPLY";
  return { ...passthrough, type: keepType, text: b.text } as NonNullable<
    TemplateComponent["buttons"]
  >[number];
}

/**
 * Meta's component array → the form's editing state.
 *
 * The inverse of the `components` memo below. Examples are read back out of
 * `example.body_text` / `body_text_named_params` so an edit starts from the
 * values Meta already reviewed rather than regenerating samples — a reviewer
 * seeing different examples on a re-submission is a needless rejection risk.
 */
function hydrateFromTemplate(t: TemplateEditTarget): {
  headerKind: HeaderKind;
  headerText: string;
  body: string;
  footer: string;
  buttons: ButtonRow[];
  examples: Record<string, string>;
  /** Present only when the template carries a LIMITED_TIME_OFFER component. */
  offerHeading?: string;
  /** Present only when the template carries a CAROUSEL component. */
  carousel?: CarouselDraft;
} {
  const comps = t.components;
  const header = comps.find((c) => c.type === "HEADER");
  const bodyComp = comps.find((c) => c.type === "BODY");
  const footerComp = comps.find((c) => c.type === "FOOTER");
  const buttonsComp = comps.find((c) => c.type === "BUTTONS");
  const ltoComp = comps.find((c) => c.type === "LIMITED_TIME_OFFER");
  const carouselComp = comps.find((c) => c.type === "CAROUSEL");

  const headerFormat = (header?.format ?? "TEXT").toUpperCase();
  const headerKind: HeaderKind = !header
    ? "none"
    : headerFormat === "TEXT" ||
        headerFormat === "IMAGE" ||
        headerFormat === "VIDEO" ||
        headerFormat === "DOCUMENT" ||
        headerFormat === "LOCATION"
      ? (headerFormat as HeaderKind)
      : "none";

  // Examples are namespaced by component exactly as the form keys them, because
  // a positional header's `{{1}}` and the first body `{{1}}` are different
  // values that would otherwise collide.
  const examples: Record<string, string> = {};
  if (t.parameterFormat === "named") {
    for (const p of bodyComp?.example?.body_text_named_params ?? []) {
      if (p.param_name) examples[`b:${p.param_name}`] = p.example ?? "";
    }
    for (const p of header?.example?.header_text_named_params ?? []) {
      if (p.param_name) examples[`h:${p.param_name}`] = p.example ?? "";
    }
  } else {
    (bodyComp?.example?.body_text?.[0] ?? []).forEach((v, i) => {
      examples[`b:${i + 1}`] = v;
    });
    const h = header?.example?.header_text?.[0];
    if (h) examples["h:1"] = h;
  }

  return {
    headerKind,
    headerText: header?.text ?? "",
    body: bodyComp?.text ?? "",
    footer: footerComp?.text ?? "",
    buttons: (buttonsComp?.buttons ?? []).map((b) => {
      const kind = (b.type ?? "").toUpperCase();
      return {
        id: cryptoRandomId(),
        kind:
          kind === "URL" || kind === "PHONE_NUMBER" || kind === "COPY_CODE"
            ? (kind as ButtonRow["kind"])
            : "QUICK_REPLY",
        text: b.text ?? "",
        url: b.url ?? "",
        phone: b.phone_number ?? "",
        example: Array.isArray(b.example) ? (b.example[0] ?? "") : (b.example ?? ""),
        // Keep the original so props the form doesn't model (app_deep_link,
        // flow configs) — and unknown TYPES — survive the edit round-trip.
        // A spread, not a double assertion: the literal is structurally a
        // Record<string, unknown> without defeating the checker.
        raw: { ...b },
      };
    }),
    examples,
    ...(ltoComp ? { offerHeading: ltoComp.limited_time_offer?.text ?? "" } : {}),
    ...(carouselComp ? { carousel: hydrateCarousel(carouselComp) } : {}),
  };
}

/**
 * A CAROUSEL component back into the editor's draft. The structure flags
 * (header format, has-body, button slots) are read from card 1 — every card
 * carries the same components, which is the rule the editor enforces on the
 * way out too.
 */
function hydrateCarousel(comp: TemplateComponent): CarouselDraft {
  const cards = comp.cards ?? [];
  const first = cards[0]?.components ?? [];
  const firstHeader = first.find((c) => c.type === "HEADER");
  return {
    enabled: true,
    headerFormat: (firstHeader?.format ?? "").toUpperCase() === "VIDEO" ? "VIDEO" : "IMAGE",
    hasBody: first.some((c) => c.type === "BODY"),
    cards: cards.map((card) => {
      const cc = card.components ?? [];
      const header = cc.find((c) => c.type === "HEADER");
      return {
        id: cryptoRandomId(),
        handle: header?.example?.header_handle?.[0] ?? null,
        // Meta never returns the original filename — the handle is the identity.
        filename: header?.example?.header_handle?.[0] ? "Uploaded" : "",
        body: cc.find((c) => c.type === "BODY")?.text ?? "",
        buttons: (cc.find((c) => c.type === "BUTTONS")?.buttons ?? []).map((b) => ({
          kind: (b.type ?? "").toUpperCase() === "URL" ? ("URL" as const) : ("QUICK_REPLY" as const),
          text: b.text ?? "",
          url: b.url ?? "",
          example: Array.isArray(b.example) ? (b.example[0] ?? "") : (b.example ?? ""),
        })),
      };
    }),
  };
}

function cryptoRandomId(): string {
  // Browser crypto.randomUUID is widely supported; tiny fallback for older
  // contexts so a button add never throws.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 12);
}
