"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Loader2,
  Search,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { TEMPLATE_LANGUAGES } from "@ccp/shared/template-languages";
import { TEMPLATE_NAME_PATTERN } from "@ccp/shared/template-render";
import { cn } from "@ccp/shared/utils";

/**
 * Browse and instantiate Meta's Template Library.
 *
 * The shape of this screen follows one fact: a library template's COPY IS FIXED.
 * You cannot edit a word of it. So there is no composer here — you pick a
 * blueprint, give it a name and a language, and fill in only the parts that are
 * genuinely yours (your URL, your phone number). In exchange, an unmodified
 * instantiation is approved immediately instead of queued for review.
 *
 * Filters mirror Meta's own enums exactly; a value we invented would return
 * nothing and read as "no templates".
 */

const TOPICS = [
  "ACCOUNT_UPDATE",
  "CUSTOMER_FEEDBACK",
  "ORDER_MANAGEMENT",
  "PAYMENTS",
] as const;

const INDUSTRIES = ["E_COMMERCE", "FINANCIAL_SERVICES"] as const;

interface LibraryTemplate {
  name: string;
  language: string;
  category: string | null;
  topic?: string;
  usecase?: string;
  industry: string[];
  header?: string;
  body: string;
  footer?: string;
  bodyParams: string[];
  bodyParamTypes: string[];
  buttons: Array<{ type: string; text?: string; url?: string; phone_number?: string }>;
  id?: string;
}

const humanize = (s: string) =>
  s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export function TemplateLibraryBrowser() {
  const router = useRouter();
  const softRefresh = useSoftRefresh();

  const [search, setSearch] = useState("");
  const [topic, setTopic] = useState("");
  const [industry, setIndustry] = useState("");
  const [language, setLanguage] = useState("en_US");

  const [templates, setTemplates] = useState<LibraryTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryTemplate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      if (search.trim()) q.set("search", search.trim());
      if (topic) q.set("topic", topic);
      if (industry) q.set("industry", industry);
      if (language) q.set("language", language);
      const res = await apiFetch(`/api/workspace/whatsapp/templates/library?${q}`);
      const data = (await res.json()) as {
        templates?: LibraryTemplate[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      setTemplates(data.templates ?? []);
    } catch (err) {
      setTemplates([]);
      setError(err instanceof Error ? err.message : "Couldn't load the library");
    } finally {
      setLoading(false);
    }
  }, [search, topic, industry, language]);

  // Debounced so typing in the search box doesn't fire one Graph read per
  // keystroke; the filter selects re-run immediately (they're deliberate).
  useEffect(() => {
    const id = window.setTimeout(() => void load(), search ? 350 : 0);
    return () => window.clearTimeout(id);
  }, [load, search]);

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
        <h1 className="text-2xl font-semibold tracking-tight">Template library</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Meta&apos;s pre-written templates for common cases — order updates,
          payment reminders, delivery notices. The wording is fixed and
          can&apos;t be edited, and in exchange an unchanged template is{" "}
          <strong>approved immediately</strong> instead of waiting for review.
        </p>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="relative flex min-w-60 flex-1 flex-col gap-1">
          <span className="text-2xs font-medium text-muted-foreground">Search</span>
          <Search className="pointer-events-none absolute bottom-2.5 left-2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="payments, delivery, refund…"
            className="pl-7"
          />
        </label>
        <FilterSelect label="Topic" value={topic} onChange={setTopic} options={TOPICS} />
        <FilterSelect
          label="Industry"
          value={industry}
          onChange={setIndustry}
          options={INDUSTRIES}
        />
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-muted-foreground">Language</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="h-9 min-w-40 rounded-md border border-input bg-background px-2 text-sm"
          >
            {TEMPLATE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{error}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading Meta&apos;s library…
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-sm text-muted-foreground">
          No library templates match those filters.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((t) => (
            <LibraryCard
              key={`${t.name}:${t.language}`}
              template={t}
              onPick={() => setSelected(t)}
            />
          ))}
        </div>
      )}

      {selected && (
        <InstantiateDialog
          template={selected}
          onClose={() => setSelected(null)}
          onCreated={() => {
            setSelected(null);
            router.push("/templates");
            softRefresh();
          }}
        />
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 min-w-40 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {humanize(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

function LibraryCard({
  template,
  onPick,
}: {
  template: LibraryTemplate;
  onPick: () => void;
}) {
  // Show the blueprint the way Meta previews it — with its own sample values
  // filled in — so what's on the card is what a customer would read.
  const filled = useMemo(
    () =>
      template.body.replace(/\{\{(\d+)\}\}/g, (m, n: string) => {
        const v = template.bodyParams[Number(n) - 1];
        return v ? v : m;
      }),
    [template],
  );
  const isForm = template.buttons.some((b) => b.type.toUpperCase() === "FLOW");

  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition hover:border-primary/40 hover:bg-accent/20"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {template.name}
        </span>
        {isForm && (
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-3xs font-medium text-primary">
            Form
          </span>
        )}
      </div>
      {template.header && (
        <div className="text-[13px] font-semibold">{template.header}</div>
      )}
      <p className="line-clamp-4 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">
        {filled}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-1 pt-1 text-3xs text-muted-foreground">
        {template.usecase && (
          <span className="rounded-full bg-muted/60 px-1.5 py-0.5">
            {humanize(template.usecase)}
          </span>
        )}
        {template.industry.map((i) => (
          <span key={i} className="rounded-full bg-muted/60 px-1.5 py-0.5">
            {humanize(i)}
          </span>
        ))}
      </div>
    </button>
  );
}

/**
 * Name it, then fill in only the parts that are genuinely per-business.
 *
 * The blueprint fixes each button's TYPE and LABEL; what varies is the
 * destination — so a URL button asks for a URL and a phone button for a number,
 * and nothing else is editable.
 */
function InstantiateDialog({
  template,
  onClose,
  onCreated,
}: {
  template: LibraryTemplate;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [buttonValues, setButtonValues] = useState<Record<number, string>>({});
  const [suffixExamples, setSuffixExamples] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = TEMPLATE_NAME_PATTERN.test(name);
  const inputsNeeded = template.buttons
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => ["URL", "PHONE_NUMBER"].includes(b.type.toUpperCase()));
  const inputsFilled = inputsNeeded.every(({ i }) => (buttonValues[i] ?? "").trim());

  const submit = useCallback(async () => {
    if (!nameValid || !inputsFilled || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const buttonInputs = inputsNeeded.map(({ b, i }) => {
        const value = (buttonValues[i] ?? "").trim();
        if (b.type.toUpperCase() === "PHONE_NUMBER") {
          return { type: "PHONE_NUMBER", phone_number: value };
        }
        // A URL carrying a variable needs a sample of the FULL url, which is
        // what Meta reviews — not just the suffix.
        const hasVar = /\{\{\s*\d+\s*\}\}/.test(value);
        return {
          type: "URL",
          url: {
            base_url: value,
            ...(hasVar
              ? { url_suffix_example: (suffixExamples[i] ?? "").trim() || value }
              : {}),
          },
        };
      });

      const res = await apiFetch("/api/workspace/whatsapp/templates/library/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          language: template.language,
          libraryTemplateName: template.name,
          ...(buttonInputs.length > 0 ? { buttonInputs } : {}),
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
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the template");
      setSubmitting(false);
    }
  }, [
    nameValid,
    inputsFilled,
    submitting,
    inputsNeeded,
    buttonValues,
    suffixExamples,
    name,
    template,
    onCreated,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-background/70 backdrop-blur-xs"
        onClick={onClose}
      />
      <div className="relative flex max-h-[85svh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <header className="border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Sparkles className="size-4 text-primary" />
            Use this template
          </h2>
          <p className="mt-0.5 text-2xs text-muted-foreground">
            The wording is Meta&apos;s and can&apos;t be changed. Unchanged, it
            skips review.
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            {template.header && (
              <div className="text-[13px] font-semibold">{template.header}</div>
            )}
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
              {template.body}
            </p>
            {template.footer && (
              <p className="mt-1.5 text-2xs text-muted-foreground">{template.footer}</p>
            )}
          </div>

          {template.bodyParamTypes.length > 0 && (
            <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
              Variable types:{" "}
              {template.bodyParamTypes.map((t, i) => (
                <span key={i} className="font-mono">
                  {i > 0 ? ", " : ""}
                  {`{{${i + 1}}}`}={humanize(t)}
                </span>
              ))}
              . Values are checked against these when you send.
            </p>
          )}

          <label className="mt-4 flex flex-col gap-1">
            <span className="text-2xs font-medium">Your name for it</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="order_delivery_update"
              autoFocus
            />
            {name.length > 0 && !nameValid && (
              <span className="text-2xs text-destructive">
                Lowercase letters, digits and underscores only.
              </span>
            )}
          </label>

          {inputsNeeded.map(({ b, i }) => (
            <label key={i} className="mt-3 flex flex-col gap-1">
              <span className="text-2xs font-medium">
                {b.type.toUpperCase() === "PHONE_NUMBER"
                  ? `Phone number for "${b.text ?? "Call"}"`
                  : `URL for "${b.text ?? "Link"}"`}
              </span>
              <Input
                value={buttonValues[i] ?? ""}
                onChange={(e) =>
                  setButtonValues((cur) => ({ ...cur, [i]: e.target.value }))
                }
                placeholder={
                  b.type.toUpperCase() === "PHONE_NUMBER"
                    ? "+15550051310"
                    : "https://yourshop.com/orders/{{1}}"
                }
              />
              {b.type.toUpperCase() === "URL" &&
                /\{\{\s*\d+\s*\}\}/.test(buttonValues[i] ?? "") && (
                  <Input
                    value={suffixExamples[i] ?? ""}
                    onChange={(e) =>
                      setSuffixExamples((cur) => ({ ...cur, [i]: e.target.value }))
                    }
                    placeholder="Example of the full link, e.g. https://yourshop.com/orders/12345"
                    className="mt-1"
                  />
                )}
            </label>
          ))}

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="wrap-break-word">{error}</span>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={!nameValid || !inputsFilled || submitting}
            className={cn("gap-1.5")}
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            {submitting ? "Creating…" : "Create template"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
