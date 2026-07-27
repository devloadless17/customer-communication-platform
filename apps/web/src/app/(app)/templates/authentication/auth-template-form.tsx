"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, Check, Loader2, ShieldCheck, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { TEMPLATE_LANGUAGES } from "@ccp/shared/template-languages";
import { TEMPLATE_NAME_PATTERN } from "@ccp/shared/template-render";
import { cn } from "@ccp/shared/utils";

/**
 * Create an authentication template.
 *
 * Deliberately NOT the composer. An authentication template's body is fixed
 * preset text Meta owns — "<CODE> is your verification code." — so there is
 * nothing to write; a composer would present an editor for copy that cannot be
 * edited. What you actually choose is which optional strings to include, which
 * OTP button to use, and which languages to generate.
 *
 * The preview pane is therefore not a nicety: it is the ONLY way to see the
 * wording, because Meta writes it per language and we never hold it.
 */

type OtpType = "COPY_CODE" | "ONE_TAP" | "ZERO_TAP";

interface Preview {
  language: string;
  body: string;
  footer?: string;
  buttons: Array<{ text?: string; autofill_text?: string }>;
}

interface SupportedApp {
  id: string;
  package_name: string;
  signature_hash: string;
}

/** Meta: at least two segments, each starting with a letter, `[a-zA-Z0-9_]`. */
const PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
/** Meta: exactly 11 characters from `[a-zA-Z0-9+/=]`. */
const HASH_PATTERN = /^[a-zA-Z0-9+/=]{11}$/;
/** Meta caps `supported_apps` at 5. */
const MAX_APPS = 5;

const OTP_TYPES: Array<{ value: OtpType; label: string; hint: string }> = [
  {
    value: "COPY_CODE",
    label: "Copy code",
    hint: "The customer taps to copy the code, then pastes it into your app. Works everywhere and needs no app integration.",
  },
  {
    value: "ONE_TAP",
    label: "One-tap autofill",
    hint: "Android only. Tapping opens your app with the code already filled in. Falls back to a copy-code button on iOS or if the eligibility check fails.",
  },
  {
    value: "ZERO_TAP",
    label: "Zero-tap",
    hint: "Android only. The code is delivered to your app without the customer tapping anything. Requires a broadcast receiver in your app.",
  },
];

export function AuthTemplateForm() {
  const router = useRouter();
  const softRefresh = useSoftRefresh();
  // Account scope stamped by the templates page's "Authentication" link — the
  // upserted templates land on that number's WABA, not the default's.
  const searchParams = useSearchParams();
  const templateAccountId = searchParams?.get("accountId") ?? null;
  const templateAccountQuery = templateAccountId
    ? `?accountId=${encodeURIComponent(templateAccountId)}`
    : "";

  const [name, setName] = useState("");
  const [languages, setLanguages] = useState<string[]>(["en_US"]);
  const [addSecurity, setAddSecurity] = useState(true);
  const [expiryMinutes, setExpiryMinutes] = useState("");
  const [otpType, setOtpType] = useState<OtpType>("COPY_CODE");
  const [apps, setApps] = useState<SupportedApp[]>([]);
  /** Zero-tap only. Meta refuses to create the template without it. */
  const [zeroTapTerms, setZeroTapTerms] = useState(false);

  const [previews, setPreviews] = useState<Preview[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsApps = otpType !== "COPY_CODE";
  const nameValid = TEMPLATE_NAME_PATTERN.test(name);
  const expiryValid =
    expiryMinutes.trim() === "" ||
    (/^\d+$/.test(expiryMinutes.trim()) &&
      Number(expiryMinutes) >= 1 &&
      Number(expiryMinutes) <= 90);
  const appsValid =
    !needsApps ||
    (apps.length > 0 &&
      apps.length <= MAX_APPS &&
      apps.every(
        (a) => PACKAGE_PATTERN.test(a.package_name) && HASH_PATTERN.test(a.signature_hash),
      ));
  const canSubmit =
    nameValid &&
    languages.length > 0 &&
    expiryValid &&
    appsValid &&
    (otpType !== "ZERO_TAP" || zeroTapTerms) &&
    !submitting;

  // Re-preview whenever anything that changes the WORDING changes. The button
  // type doesn't — Meta returns both labels regardless — so it isn't a dep.
  const loadPreview = useCallback(async () => {
    if (languages.length === 0) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const q = new URLSearchParams({ languages: languages.join(",") });
      if (addSecurity) q.set("addSecurityRecommendation", "true");
      if (expiryValid && expiryMinutes.trim()) {
        q.set("codeExpirationMinutes", expiryMinutes.trim());
      }
      const res = await apiFetch(`/api/workspace/whatsapp/templates/auth/preview?${q}`);
      const data = (await res.json()) as {
        previews?: Preview[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      setPreviews(data.previews ?? []);
    } catch (err) {
      setPreviews([]);
      setPreviewError(err instanceof Error ? err.message : "Couldn't load the preview");
    } finally {
      setPreviewing(false);
    }
  }, [languages, addSecurity, expiryMinutes, expiryValid]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadPreview(), 300);
    return () => window.clearTimeout(id);
  }, [loadPreview]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/whatsapp/templates/auth/upsert${templateAccountQuery}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          languages,
          otpType,
          addSecurityRecommendation: addSecurity,
          ...(expiryMinutes.trim()
            ? { codeExpirationMinutes: Number(expiryMinutes.trim()) }
            : {}),
          ...(otpType === "ZERO_TAP" ? { zeroTapTermsAccepted: zeroTapTerms } : {}),
          ...(needsApps
            ? {
                supportedApps: apps.map((a) => ({
                  package_name: a.package_name.trim(),
                  signature_hash: a.signature_hash.trim(),
                })),
              }
            : {}),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok || !data.ok) {
        throw new Error(
          [data.error, data.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      router.push("/templates");
      softRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the template");
      setSubmitting(false);
    }
  }, [
    canSubmit,
    name,
    languages,
    otpType,
    addSecurity,
    expiryMinutes,
    needsApps,
    apps,
    zeroTapTerms,
    router,
    softRefresh,
    templateAccountQuery,
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <header className="flex flex-col gap-1">
        <Link
          href="/templates"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to templates
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ShieldCheck className="size-5 text-primary" />
          Authentication template
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          For one-time passcodes. The wording is Meta&apos;s and can&apos;t be
          edited — you pick the options and the languages, and Meta writes it.
          Creating the same name for more languages later just adds them.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-5">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="verification_code"
            />
            {name.length > 0 && !nameValid && (
              <span className="text-2xs text-destructive">
                Lowercase letters, digits and underscores only.
              </span>
            )}
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">
              Languages{" "}
              <span className="font-normal text-muted-foreground">
                ({languages.length} selected)
              </span>
            </span>
            <p className="mb-1 text-2xs text-muted-foreground">
              One template is created per language, all under the same name.
            </p>
            <div className="max-h-44 overflow-y-auto rounded-md border border-border p-2">
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {TEMPLATE_LANGUAGES.map((l) => (
                  <label key={l.code} className="flex items-center gap-1.5 text-2xs">
                    <input
                      type="checkbox"
                      checked={languages.includes(l.code)}
                      onChange={(e) =>
                        setLanguages((cur) =>
                          e.target.checked
                            ? [...cur, l.code]
                            : cur.filter((c) => c !== l.code),
                        )
                      }
                    />
                    <span className="truncate">{l.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
            <span className="text-xs font-medium">Optional text</span>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={addSecurity}
                onChange={(e) => setAddSecurity(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-2xs leading-relaxed text-muted-foreground">
                Add the security line — <em>&ldquo;For your security, do not share
                this code.&rdquo;</em>
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-2xs text-muted-foreground">
                Code expiry in minutes (1–90, optional)
              </span>
              <Input
                value={expiryMinutes}
                onChange={(e) => setExpiryMinutes(e.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
                placeholder="e.g. 10"
                className="max-w-40"
              />
              {!expiryValid && (
                <span className="text-2xs text-destructive">
                  Must be between 1 and 90.
                </span>
              )}
              <span className="text-2xs text-muted-foreground">
                Adds an expiry line and disables the button after this long. Left
                blank, no expiry line appears and the button lasts 10 minutes.
              </span>
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium">How the customer gets the code</span>
            {OTP_TYPES.map((t) => (
              <label
                key={t.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition-colors",
                  otpType === t.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent/30",
                )}
              >
                <input
                  type="radio"
                  name="otpType"
                  checked={otpType === t.value}
                  onChange={() => setOtpType(t.value)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-xs font-medium">{t.label}</span>
                  <span className="block text-2xs leading-relaxed text-muted-foreground">
                    {t.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {/* Not a nicety: Meta will NOT create a zero-tap template without this
              acknowledgement, and the obligation it describes (telling customers
              the code is filled in for them) is a real one. */}
          {otpType === "ZERO_TAP" && (
            <label className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2">
              <input
                type="checkbox"
                checked={zeroTapTerms}
                onChange={(e) => setZeroTapTerms(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-2xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-warning-fg">
                  Zero-tap terms.
                </span>{" "}
                I understand zero-tap use is subject to the WhatsApp Business
                Terms of Service, and that it&apos;s my responsibility to make
                sure customers expect the code to be filled in for them when they
                choose WhatsApp.
              </span>
            </label>
          )}

          {needsApps && (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <span className="text-xs font-medium">Your Android app</span>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {otpType} hands the code straight to your app, so Meta needs to
                know which app is allowed to receive it. Up to {MAX_APPS} builds.
              </p>
              {apps.map((a, i) => (
                <div key={a.id} className="flex flex-col gap-1 rounded-md border border-border p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-2xs text-muted-foreground">App {i + 1}</span>
                    <button
                      type="button"
                      onClick={() => setApps((cur) => cur.filter((x) => x.id !== a.id))}
                      className="ml-auto rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Remove app"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <Input
                    value={a.package_name}
                    onChange={(e) =>
                      setApps((cur) =>
                        cur.map((x) =>
                          x.id === a.id ? { ...x, package_name: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="com.example.myapp"
                  />
                  {a.package_name.length > 0 && !PACKAGE_PATTERN.test(a.package_name) && (
                    <span className="text-2xs text-destructive">
                      Needs at least two dot-separated segments, each starting with a letter.
                    </span>
                  )}
                  <Input
                    value={a.signature_hash}
                    onChange={(e) =>
                      setApps((cur) =>
                        cur.map((x) =>
                          x.id === a.id ? { ...x, signature_hash: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="Signing key hash (11 characters)"
                  />
                  {a.signature_hash.length > 0 && !HASH_PATTERN.test(a.signature_hash) && (
                    <span className="text-2xs text-destructive">
                      Must be exactly 11 characters (letters, digits, + / =).
                    </span>
                  )}
                </div>
              ))}
              {apps.length < MAX_APPS && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() =>
                    setApps((cur) => [
                      ...cur,
                      {
                        id: Math.random().toString(36).slice(2),
                        package_name: "",
                        signature_hash: "",
                      },
                    ])
                  }
                >
                  Add app
                </Button>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="wrap-break-word">{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" asChild>
              <Link href="/templates">Cancel</Link>
            </Button>
            <Button type="button" onClick={submit} disabled={!canSubmit} className="gap-1.5">
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              {submitting
                ? "Creating…"
                : `Create ${languages.length} template${languages.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>

        {/* The preview is the only way to see the wording — Meta writes it. */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>What Meta will send</span>
              {previewing && <Loader2 className="size-3 animate-spin" />}
              <span className="h-px flex-1 bg-border" />
            </div>
            {previewError ? (
              <p className="text-2xs text-destructive">{previewError}</p>
            ) : previews.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                Pick a language to see the exact wording.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {previews.map((p) => (
                  <div key={p.language} className="rounded-lg border border-border p-3">
                    <div className="mb-1 font-mono text-3xs text-muted-foreground">
                      {p.language}
                    </div>
                    <p className="whitespace-pre-wrap text-[13px] leading-relaxed">
                      {p.body}
                    </p>
                    {p.footer && (
                      <p className="mt-1.5 text-2xs text-muted-foreground">{p.footer}</p>
                    )}
                    {p.buttons.length > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        {p.buttons.map((b, i) => (
                          <div
                            key={i}
                            className="rounded-md border border-border bg-background px-2 py-1.5 text-center text-xs font-medium text-primary"
                          >
                            {otpType === "ONE_TAP"
                              ? (b.autofill_text ?? b.text)
                              : (b.text ?? b.autofill_text)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <p className="mt-3 text-2xs leading-relaxed text-muted-foreground">
              The code itself replaces the placeholder when you send. Values are
              capped at 15 characters, and URLs, media and emoji aren&apos;t
              allowed in this category.
            </p>
            {/* Not a rule we enforce — an alphanumeric code is perfectly valid
                and Meta's own example uses one. It just silently loses iOS
                autofill, which is worth knowing while you're choosing a format
                rather than discovering later. */}
            <p className="mt-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-2xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Tip:</span> on iOS 26+,
              the keyboard offers one-tap autofill only for{" "}
              <span className="font-medium">numeric codes of 3–8 digits</span>.
              Letters or symbols still work — the customer just uses the copy
              button instead.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
