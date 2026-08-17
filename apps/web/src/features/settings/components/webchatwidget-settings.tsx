"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Plus, Trash2 } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";
import { PageHeader } from "@/components/layouts/page-header";
import type { WebchatWidgetView } from "@/lib/api/queries";
import type { ContactFieldDefinition } from "@ccp/shared/types";
import { PRECHAT_BUILTIN_TARGETS } from "@ccp/shared/contacts/prechat-targets";

type Field = NonNullable<WebchatWidgetView["config"]["preChatFields"]>[number];
const BRAND = "#4f46e5";

function contrastOn(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return "#fff";
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? "#0d1220" : "#fff";
}

const inputCls =
  "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20";

export function WebchatWidgetSettings({
  widgets: initial,
  canManage,
  appOrigin,
  contactFields: initialContactFields,
  canCreateFields,
}: {
  widgets: WebchatWidgetView[];
  canManage: boolean;
  appOrigin: string;
  contactFields: ContactFieldDefinition[];
  canCreateFields: boolean;
}) {
  const [widgets, setWidgets] = useState<WebchatWidgetView[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fields created from the pre-chat picker, held only until the server's list
  // catches up. Deliberately NOT `useState(initialContactFields)`: that freezes
  // the list at mount, so a field added over in Settings → Contact fields never
  // appeared here — even though creating one publishes `team:catalog:changed`,
  // which refreshes this route and hands us fresh props. Merging keeps the
  // server authoritative while a just-created field is selectable immediately.
  const [createdFields, setCreatedFields] = useState<ContactFieldDefinition[]>([]);
  const contactFields = useMemo(() => {
    const byKey = new Map(initialContactFields.map((d) => [d.key, d]));
    for (const d of createdFields) if (!byKey.has(d.key)) byKey.set(d.key, d);
    return [...byKey.values()];
  }, [initialContactFields, createdFields]);
  // Transient "Saved ✓" on the button — without it a successful save gave no
  // feedback at all (the button just flicked back to "Save changes").
  const [saved, setSaved] = useState(false);

  const selected = widgets.find((w) => w.id === selectedId) ?? null;

  function patchLocal(id: string, patch: Partial<WebchatWidgetView>) {
    setWidgets((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }
  function patchConfig(id: string, patch: Partial<WebchatWidgetView["config"]>) {
    setWidgets((ws) => ws.map((w) => (w.id === id ? { ...w, config: { ...w.config, ...patch } } : w)));
  }

  async function createWidget() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/workspace/webchatwidget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Website ${widgets.length + 1}`, allowedOrigins: [] }),
      });
      // Read the failure BEFORE parsing the success shape — the helper needs an
      // unconsumed body, and it prefers the API's human `detail` over the raw
      // `error` key. The thrown message is what the catch below renders.
      if (!res.ok) throw new Error(await apiErrorMessage(res, "Couldn't create the widget."));
      const data = (await res.json()) as { widget?: WebchatWidgetView };
      if (!data.widget) throw new Error("Couldn't create the widget.");
      setWidgets((ws) => [...ws, data.widget!]);
      setSelectedId(data.widget.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the widget.");
    } finally {
      setBusy(false);
    }
  }

  async function save(w: WebchatWidgetView) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/webchatwidget/${w.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: w.name,
          allowedOrigins: w.allowedOrigins,
          isActive: w.isActive,
          theme: w.config.theme ?? {},
          welcomeMessage: w.config.welcomeMessage ?? "",
          headerTitle: w.config.headerTitle ?? "",
          headerSubtitle: w.config.headerSubtitle ?? "",
          suggestedQuestions: w.config.suggestedQuestions ?? [],
          // `options` is attached by the server for the WIDGET's benefit and is not
          // part of the write schema (which is .strict()) — never echo it back.
          preChatFields: (w.config.preChatFields ?? []).map(({ options: _options, ...f }) => f),
          showBranding: w.config.showBranding ?? true,
          logoDataUrl: w.config.logoDataUrl ?? "",
          agentAvatarDataUrl: w.config.agentAvatarDataUrl ?? "",
          fontFamily: w.config.fontFamily ?? "system",
          themeMode: w.config.themeMode ?? "light",
          soundEnabled: w.config.soundEnabled ?? false,
          // Absent means "all kinds" — only send an explicit list once the org has
          // actually restricted something, so untouched widgets stay unrestricted.
          ...(w.config.allowedMediaKinds ? { allowedMediaKinds: w.config.allowedMediaKinds } : {}),
          awayMessage: w.config.awayMessage ?? "",
          aiEnabled: w.config.aiEnabled ?? false,
          showHeader: w.config.showHeader ?? true,
          showAgentName: w.config.showAgentName ?? true,
          phoneDialCode: w.config.phoneDialCode ?? "",
          launcher: w.config.launcher ?? "bubble",
          position: w.config.position ?? "right",
          launcherLabel: w.config.launcherLabel ?? "",
        }),
      });
      // Read the failure BEFORE parsing the success shape — the helper needs an
      // unconsumed body, and it prefers the API's human `detail` over the raw
      // `error` key. The thrown message is what the catch below renders.
      if (!res.ok) throw new Error(await apiErrorMessage(res, "Couldn't save the widget."));
      const data = (await res.json()) as { widget?: WebchatWidgetView };
      if (!data.widget) throw new Error("Couldn't save the widget.");
      patchLocal(w.id, data.widget);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the widget.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this widget? Existing conversations keep their history.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/webchatwidget/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await apiErrorMessage(res, "Couldn't delete the widget."));
      // Select the next surviving widget — clearing to null with one widget left
      // rendered a blank page (no tabs below 2 widgets, no editor without a selection).
      const next = widgets.filter((w) => w.id !== id);
      setWidgets(next);
      setSelectedId((cur) => (cur === id ? (next[0]?.id ?? null) : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the widget.");
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="Website chat" description="Admins only." />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6">
      <PageHeader
        title="Website chat"
        description="Embed a chat widget on any website. Each site gets its own named widget so you always know where a chat came from."
        action={
          <button
            onClick={createWidget}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="size-4" /> New widget
          </button>
        }
      />

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {widgets.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground">
          No widgets yet. Create one to get an embed snippet for your website.
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          {/* widget tabs */}
          {widgets.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {widgets.map((w) => (
                <button
                  key={w.id}
                  onClick={() => setSelectedId(w.id)}
                  className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition ${
                    w.id === selectedId ? "border-primary bg-primary/5 font-medium shadow-sm" : "text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  <span className="max-w-[180px] truncate">{w.name}</span>
                  <span className="text-2xs opacity-70">{w.conversationCount}</span>
                  {!w.isActive && <span className="rounded bg-muted px-1 text-2xs">off</span>}
                  {/* Unlocked = embeddable anywhere. Visible from the LIST so an
                      admin who never opens the Install tab still sees it. */}
                  {w.isActive && w.allowedOrigins.length === 0 && (
                    <span
                      className="rounded border border-amber-500/40 bg-amber-500/10 px-1 text-2xs text-amber-700 dark:text-amber-400"
                      title="No allowed domains — any site can embed this widget. Lock it in the Install tab."
                    >
                      open to any site
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {selected && (
            <Editor
              key={selected.id}
              widget={selected}
              appOrigin={appOrigin}
              busy={busy}
              saved={saved}
              error={error}
              contactFields={contactFields}
              canCreateFields={canCreateFields}
              onFieldCreated={(def) => setCreatedFields((cur) => (cur.some((d) => d.key === def.key) ? cur : [...cur, def]))}
              onName={(name) => patchLocal(selected.id, { name })}
              onActive={(isActive) => patchLocal(selected.id, { isActive })}
              onOrigins={(allowedOrigins) => patchLocal(selected.id, { allowedOrigins })}
              onConfig={(patch) => patchConfig(selected.id, patch)}
              onSave={() => save(selected)}
              onDelete={() => remove(selected.id)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Editor({
  widget,
  appOrigin,
  busy,
  saved,
  error,
  contactFields,
  canCreateFields,
  onFieldCreated,
  onName,
  onActive,
  onOrigins,
  onConfig,
  onSave,
  onDelete,
}: {
  widget: WebchatWidgetView;
  appOrigin: string;
  busy: boolean;
  saved: boolean;
  error: string | null;
  contactFields: ContactFieldDefinition[];
  canCreateFields: boolean;
  onFieldCreated: (def: ContactFieldDefinition) => void;
  onName: (v: string) => void;
  onActive: (v: boolean) => void;
  onOrigins: (v: string[]) => void;
  onConfig: (patch: Partial<WebchatWidgetView["config"]>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const c = widget.config;
  const theme = c.theme ?? {};
  const [originDraft, setOriginDraft] = useState("");
  // Group the many fields into tabs so the page isn't one long scroll. The live
  // preview stays visible across all tabs so every edit is seen immediately.
  const [tab, setTab] = useState<"content" | "appearance" | "behavior" | "install">("content");
  /** Fold the typed origin into the list. Shared by Enter and blur so a domain
   *  typed-then-Saved can't be silently dropped. Idempotent + de-duping. */
  function commitOrigin() {
    const v = originDraft.trim();
    if (!v) return;
    if (!widget.allowedOrigins.includes(v)) onOrigins([...widget.allowedOrigins, v]);
    setOriginDraft("");
  }
  const origin = appOrigin || "https://YOUR-APP";
  const scriptTag = buildScript(origin, widget.publicKey, c);
  const inlineScriptTag = `<script src="${origin}/widget.js" data-webchat-key="${widget.publicKey}" data-webchat-target="#ccp-chat" defer></script>`;
  // In production Caddy fronts the app and the API on ONE origin, so these collapse
  // to the same host — which is exactly what a customer needs in their CSP. Split
  // out anyway so the values stay correct if the API is ever served separately.
  const isInline = (c.launcher ?? "bubble") === "inline";
  const apiOrigin = origin;
  const wsOrigin = origin.replace(/^http/, "ws");

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <TabBar
        tab={tab}
        onTab={setTab}
        tabs={[
          { id: "content", label: "Content" },
          { id: "appearance", label: "Appearance" },
          { id: "behavior", label: "Behavior" },
          { id: "install", label: "Install" },
        ]}
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* form — one tab visible at a time */}
        <div className="flex min-w-0 flex-col gap-5">
          {tab === "content" && (
          <Section title="Content">
            <Field label="Widget name" hint="Internal — how you identify this site.">
              <input value={widget.name} onChange={(e) => onName(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Header title" hint="Shown to visitors at the top of the chat.">
              <input value={c.headerTitle ?? ""} placeholder={widget.name} onChange={(e) => onConfig({ headerTitle: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Header subtitle">
              <input value={c.headerSubtitle ?? ""} placeholder="Typically replies in a few minutes" onChange={(e) => onConfig({ headerSubtitle: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Welcome message">
              <textarea value={c.welcomeMessage ?? ""} onChange={(e) => onConfig({ welcomeMessage: e.target.value })} rows={2} className={`${inputCls} resize-y`} />
            </Field>
            <Field label="Away message" hint="Shown when no agent is online, so visitors know to expect an email reply.">
              <input value={c.awayMessage ?? ""} placeholder="We're away right now — leave a message and we'll reply by email." onChange={(e) => onConfig({ awayMessage: e.target.value })} className={inputCls} />
            </Field>
            <Field label="Suggested questions" hint="One per line, up to 6.">
              <SuggestedQuestions
                key={widget.id}
                value={c.suggestedQuestions ?? []}
                onChange={(suggestedQuestions) => onConfig({ suggestedQuestions })}
                className={`${inputCls} resize-y`}
              />
            </Field>
          </Section>
          )}

          {tab === "appearance" && (
          <Section title="Appearance">
            <div className="grid grid-cols-3 gap-3">
              <ColorField label="Primary" value={theme.primaryColor} onChange={(v) => onConfig({ theme: { ...theme, primaryColor: v } })} />
              <ColorField label="Launcher" value={theme.launcherColor} onChange={(v) => onConfig({ theme: { ...theme, launcherColor: v } })} />
              <ColorField label="Your bubble" value={theme.userBubbleColor} onChange={(v) => onConfig({ theme: { ...theme, userBubbleColor: v } })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Font">
                <select value={c.fontFamily ?? "system"} onChange={(e) => onConfig({ fontFamily: e.target.value as "system" | "rounded" | "serif" })} className={inputCls}>
                  <option value="system">System</option>
                  <option value="rounded">Rounded</option>
                  <option value="serif">Serif</option>
                </select>
              </Field>
              <Field label="Theme">
                <select value={c.themeMode ?? "light"} onChange={(e) => onConfig({ themeMode: e.target.value as "light" | "dark" | "auto" })} className={inputCls}>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="auto">Auto (system)</option>
                </select>
              </Field>
            </div>
          </Section>
          )}

          {tab === "appearance" && (
          <Section title="Branding">
            <div className="grid grid-cols-2 gap-4">
              <ImageUpload label="Logo" value={c.logoDataUrl} maxKb={64} onChange={(v) => onConfig({ logoDataUrl: v })} />
              <ImageUpload label="Agent avatar" value={c.agentAvatarDataUrl} maxKb={40} onChange={(v) => onConfig({ agentAvatarDataUrl: v })} />
            </div>
          </Section>
          )}

          {tab === "behavior" && (
          <Section
            title="Launcher & placement"
            desc="These shape the install snippet, not the live widget — after changing them, re-copy the snippet from the Install tab onto your site."
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Deploy mode" hint="One per page — the widget is a singleton.">
                <select value={c.launcher ?? "bubble"} onChange={(e) => onConfig({ launcher: e.target.value as "bubble" | "off" | "inline" })} className={inputCls}>
                  <option value="bubble">Floating bubble</option>
                  <option value="off">Hidden (open from a link)</option>
                  <option value="inline">Inline (inside your page)</option>
                </select>
              </Field>
              {/* Position and label only mean something when a launcher exists —
                  an inline embed has neither, so showing them implied a choice
                  that silently did nothing. */}
              {isInline ? (
                <Field label="Size" hint="Set on your container, not here.">
                  <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    The chat fills the element you point it at — give that element a
                    height in your own CSS. See the install snippet below.
                  </p>
                </Field>
              ) : (
                <Field label="Position">
                  <select value={c.position ?? "right"} onChange={(e) => onConfig({ position: e.target.value as "right" | "left" })} className={inputCls}>
                    <option value="right">Bottom right</option>
                    <option value="left">Bottom left</option>
                  </select>
                </Field>
              )}
            </div>
            {!isInline && (
              <Field label="Bubble label" hint="Optional text beside the bubble.">
                <input value={c.launcherLabel ?? ""} placeholder="e.g. Chat with us" onChange={(e) => onConfig({ launcherLabel: e.target.value })} className={inputCls} />
              </Field>
            )}
            {isInline && (
              <Toggle
                checked={c.showHeader !== false}
                onChange={(v) => onConfig({ showHeader: v })}
                label="Show chat header"
                hint="Turn off for a bare “just chat” embed — your page’s own header frames it."
              />
            )}
          </Section>
          )}

          {tab === "behavior" && (
          <Section
            title="Pre-chat form"
            desc="Optionally ask for a few details before the chat starts. Name, Email and Phone fill the contact's own details; choose Text for anything else — it's saved as a workspace contact field, created automatically from the label."
          >
            <PreChatEditor
              fields={c.preChatFields ?? []}
              onChange={(preChatFields) => onConfig({ preChatFields })}
              contactFields={contactFields}
              canCreateFields={canCreateFields}
              onFieldCreated={onFieldCreated}
            />
            {(c.preChatFields ?? []).some((f) => f.type === "phone") && (
              <Field label="Phone dial code" hint="Prefilled in the phone field so visitors don't drop their country code.">
                <input
                  value={c.phoneDialCode ?? ""}
                  placeholder="e.g. 961"
                  inputMode="numeric"
                  onChange={(e) => onConfig({ phoneDialCode: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                  className={inputCls}
                />
              </Field>
            )}
          </Section>
          )}

          {tab === "install" && (
          <Section title="Allowed domains" desc="Only these sites may embed the widget. An empty list allows any site (useful while testing).">
            {/* Trust-on-first-use. Your site key is public — it's in the page source
                of every page you install it on — so an unlocked widget can be lifted
                onto someone else's site and used to impersonate you. Rather than
                demand a domain up front (which would block a first install), we show
                the domain we actually observed and make locking to it one click. */}
            {widget.allowedOrigins.length === 0 && widget.firstSeenOrigin && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  This widget is currently open to <strong className="text-foreground">any site</strong>. We&apos;ve seen it
                  used on <strong className="text-foreground">{widget.firstSeenOrigin}</strong>.
                </span>
                <button
                  onClick={() => onOrigins([widget.firstSeenOrigin!])}
                  className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground transition hover:opacity-90"
                >
                  Lock to {widget.firstSeenOrigin}
                </button>
              </div>
            )}
            {/* The unlocked state must never be visually QUIET — before a first
                visitor arrives there is no firstSeenOrigin to lock to, and the
                old neutral gray line read as "nothing to do here". */}
            {widget.allowedOrigins.length === 0 && !widget.firstSeenOrigin && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                This widget is currently open to <strong className="text-foreground">any site</strong>.
                Your site key is public, so anyone can embed it and impersonate you — add your
                domain below to lock it down.
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {widget.allowedOrigins.length === 0 && (
                <span className="text-xs text-muted-foreground">Any site (not recommended) — add your domains below.</span>
              )}
              {widget.allowedOrigins.map((o) => (
                <span key={o} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs">
                  {o}
                  <button onClick={() => onOrigins(widget.allowedOrigins.filter((x) => x !== o))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${o}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              value={originDraft}
              aria-label="Add an allowed origin"
              onChange={(e) => setOriginDraft(e.target.value)}
              // Commit on BLUR as well as Enter. Enter-only silently discarded a
              // typed domain when the admin went straight to "Save changes" — and
              // an empty allow-list is permissive to EVERY site (origin-allow.ts),
              // so the failure mode was the exact opposite of the admin's intent.
              // Blur fires before the Save click, so the value lands first.
              onBlur={() => commitOrigin()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitOrigin();
                }
              }}
              placeholder="example.com or *.example.com — press Enter to add"
              className={inputCls}
            />
          </Section>
          )}

          {tab === "behavior" && (
          <Section title="Behavior">
            <Toggle checked={c.aiEnabled === true} onChange={(v) => onConfig({ aiEnabled: v })} label="AI auto-reply" hint="Let the AI assistant answer this widget's chats automatically. Off by default — turn on once you've reviewed how it responds." />
            <Toggle checked={c.soundEnabled === true} onChange={(v) => onConfig({ soundEnabled: v })} label="Play a chime on new messages" hint="A subtle sound when an agent replies." />
            <Toggle checked={c.showAgentName !== false} onChange={(v) => onConfig({ showAgentName: v })} label="Show agent name to visitors" hint="When off, replies appear without the replying agent's name — agents stay anonymous." />
            <AttachmentPolicy value={c.allowedMediaKinds} onChange={(allowedMediaKinds) => onConfig({ allowedMediaKinds })} />
            <Toggle checked={c.showBranding !== false} onChange={(v) => onConfig({ showBranding: v })} label="Show “Powered by” footer" />
            <Toggle checked={widget.isActive} onChange={onActive} label="Active" hint="Turning this off disables the widget on your site completely — existing conversations included, not just new chats." />
          </Section>
          )}
        </div>

        {/* sticky preview — fits its column, never overflows */}
        <div className="min-w-0">
          <div className="flex flex-col gap-2.5 xl:sticky xl:top-4">
            <p className="text-xs font-medium text-muted-foreground">Live preview</p>
            <div className="flex justify-center overflow-hidden rounded-2xl border bg-muted/40 p-4">
              <Preview widget={widget} />
            </div>
          </div>
        </div>
      </div>

      {/* install */}
      {tab === "install" && (
      <Section title="Install on your website" desc={`Public key: ${widget.publicKey}`}>
        {/* ONE snippet per mode. Showing every variant at once was the old
            behaviour and it read as a menu of things to paste — but the widget is
            a per-page singleton, so a customer pasting two of them silently gets
            whichever ran first. */}
        {isInline ? (
          <>
            <CopyBox
              title="1) Add a container where the chat should appear"
              hint="The chat FILLS this element, so its height is yours to choose. A container with no height renders nothing."
              code={`<div id="ccp-chat" style="height:600px;max-width:440px"></div>`}
            />
            <CopyBox title="2) Add the widget" hint="Paste before &lt;/body&gt;." code={inlineScriptTag} />
            <CopyBox
              title="Full-page chat instead?"
              hint="Use 100dvh, not 100vh — on mobile, 100vh ignores the browser toolbars and pushes the message box off-screen."
              code={`<div id="ccp-chat" style="height:100dvh;width:100%"></div>`}
            />
            <CopyBox
              title="React / Next / Vue"
              hint="SPAs create the container AFTER the script runs. The widget waits for it automatically; call mount() if yours appears later than 15s."
              code={`useEffect(() => {\n  window.CCPWebchat?.mount("#ccp-chat");\n}, []);`}
            />
          </>
        ) : (c.launcher ?? "bubble") === "off" ? (
          <>
            <CopyBox title="1) Add the widget (bubble hidden)" hint="Paste before &lt;/body&gt; on every page." code={scriptTag} />
            <CopyBox
              title="2) Open it from any link or button"
              hint="Include both lines. The first keeps early clicks working while the widget is still loading."
              code={`${CCP_WEBCHAT_STUB}\n<a href="#" onclick="CCPWebchat.open();return false">Chat with us</a>`}
            />
          </>
        ) : (
          <CopyBox title="Floating bubble" hint="Paste before &lt;/body&gt; on every page — a chat bubble appears." code={scriptTag} />
        )}
        <CopyBox
          title="Content-Security-Policy (only if your site sets one)"
          hint="Add these sources, or the widget is blocked. Avatars are inline data: URLs, and media streams from the API origin."
          code={[
            `script-src  ${origin};`,
            `connect-src ${origin} ${apiOrigin} ${wsOrigin};`,
            `img-src     ${apiOrigin} data:;`,
            `media-src   ${apiOrigin};`,
            `style-src   'unsafe-inline';`,
          ].join("\n")}
        />
        {/* Try it before touching the customer's site. Without this the first
            real proof the widget works is a live page on their domain, where a
            failure is both visible to their visitors and hard to diagnose. The
            key is pre-filled so nobody hand-copies 30 characters. */}
        <a
          href={`/webchat/test.html?key=${encodeURIComponent(widget.publicKey)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary transition hover:underline"
        >
          <ExternalLink className="size-3.5" />
          Test this widget on a sample page
        </a>
        <p className="text-xs text-muted-foreground">
          Sending this to your web developer? The{" "}
          <a href="/docs/webchat-install" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            full installation guide
          </a>{" "}
          covers sizing, single-page apps, allowed domains, CSP, and troubleshooting.
        </p>
      </Section>
      )}

      <div className="flex items-center justify-between gap-3">
        <button onClick={onDelete} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive transition hover:bg-destructive/5 disabled:opacity-50">
          <Trash2 className="size-4" /> Delete
        </button>
        <div className="flex min-w-0 items-center gap-3">
          {/* The page-top banner can be scrolled out of view on the long Install
              tab — repeat the failure right where the admin is looking. */}
          {error && <span className="truncate text-xs text-destructive">{error}</span>}
          <button onClick={onSave} disabled={busy} className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {busy ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── small building blocks ────────────────────────────────────────────────────

/**
 * Segmented tab control that groups the widget's many settings so the page reads as
 * four short sections instead of one long scroll. Flat, accessible (role=tab), and
 * the active tab is clear by fill + weight, not colour alone.
 */
function TabBar<T extends string>({
  tab,
  onTab,
  tabs,
}: {
  tab: T;
  onTab: (t: T) => void;
  tabs: ReadonlyArray<{ id: T; label: string }>;
}) {
  return (
    <div role="tablist" className="flex w-full gap-1 rounded-xl border bg-muted/40 p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onTab(t.id)}
          className={`flex-1 cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            tab === t.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl border bg-card p-4 sm:p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium">{label}</span>
      {children}
      {hint && <span className="text-2xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/**
 * What visitors are allowed to attach.
 *
 * `undefined` means "everything" — the default, and what every widget created before
 * this setting existed has. Only once an org toggles something off do we persist an
 * explicit list, so we never silently narrow an existing widget. Turning all four off
 * gives a text-only chat, and the widget then hides the attach and mic buttons
 * entirely rather than showing controls that would fail.
 *
 * The toggles are a convenience: the policy is enforced server-side on the upload
 * endpoint, because the widget runs on the customer's own page.
 */
const MEDIA_KINDS = [
  { key: "image" as const, label: "Images", hint: "Photos and screenshots" },
  { key: "audio" as const, label: "Voice notes & audio", hint: "Also hides the microphone button" },
  { key: "video" as const, label: "Videos", hint: "Clips and screen recordings" },
  { key: "document" as const, label: "Documents", hint: "PDF, Word, Excel, PowerPoint, text" },
];

function AttachmentPolicy({
  value,
  onChange,
}: {
  value?: Array<"image" | "video" | "audio" | "document">;
  onChange: (v: Array<"image" | "video" | "audio" | "document">) => void;
}) {
  const current = value ?? MEDIA_KINDS.map((k) => k.key);
  const has = (k: (typeof MEDIA_KINDS)[number]["key"]) => current.includes(k);
  const toggle = (k: (typeof MEDIA_KINDS)[number]["key"]) =>
    onChange(has(k) ? current.filter((x) => x !== k) : [...current, k]);
  const none = current.length === 0;
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">What visitors can attach</p>
        <p className="text-2xs text-muted-foreground">
          {none
            ? "Text-only chat — the attach and microphone buttons are hidden."
            : "Turn everything off for a text-only chat."}
        </p>
      </div>
      {MEDIA_KINDS.map((k) => (
        <Toggle key={k.key} checked={has(k.key)} onChange={() => toggle(k.key)} label={k.label} hint={k.hint} />
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-3 text-left">
      <span className="flex flex-col">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-2xs text-muted-foreground">{hint}</span>}
      </span>
      <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-primary" : "bg-muted-foreground/30"}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition ${checked ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

function ColorField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  const v = value && /^#[0-9a-f]{6}$/i.test(value) ? value : BRAND;
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 rounded-lg border bg-background px-2 py-1.5">
        <input type="color" value={v} onChange={(e) => onChange(e.target.value)} className="size-6 cursor-pointer rounded border-0 bg-transparent p-0" />
        <span className="truncate text-2xs uppercase text-muted-foreground">{v}</span>
      </div>
    </label>
  );
}

/**
 * Pre-load call queue stub for the JS API. The embed script is `defer`red, so a
 * visitor can click a `CCPWebchat.open()` link BEFORE widget.js executes — without
 * this stub that throws ReferenceError, `return false` never runs, and the host
 * page navigates to `#` instead of opening the chat. The stub buffers calls into
 * `q`, which widget.js drains on load.
 */
const CCP_WEBCHAT_STUB =
  `<script>window.CCPWebchat=window.CCPWebchat||{q:[],` +
  `open:function(){this.q.push(["open"])},` +
  `close:function(){this.q.push(["close"])},` +
  `toggle:function(){this.q.push(["toggle"])},` +
  `isOpen:function(){return false}};</script>`;

/** Build the `<script>` embed tag with the org's launcher/position/label choices. */
function buildScript(origin: string, key: string, c: WebchatWidgetView["config"]): string {
  // The label is free text (≤40 chars) — escape it or a quote in the label breaks
  // the copyable snippet's attribute quoting.
  const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const attrs = [`data-webchat-key="${key}"`];
  if ((c.position ?? "right") === "left") attrs.push(`data-webchat-position="left"`);
  if (c.launcherLabel) attrs.push(`data-webchat-label="${escAttr(c.launcherLabel)}"`);
  if ((c.launcher ?? "bubble") === "off") attrs.push(`data-webchat-launcher="off"`);
  return `<script src="${origin}/widget.js" ${attrs.join(" ")} defer></script>`;
}

function CopyBox({ title, hint, code }: { title: string; hint: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-semibold">{title}</p>
      <p className="text-2xs text-muted-foreground">{hint}</p>
      <div className="flex min-w-0 items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-lg bg-muted px-3 py-2.5 text-2xs leading-relaxed">
          {code}
        </code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex shrink-0 items-center gap-1 self-start rounded-lg border px-2.5 py-2 text-xs transition hover:bg-muted"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * Downscale a picked image to a small square data URL BEFORE storing.
 *
 * These data URLs ride in the config payload delivered to EVERY visitor on every
 * page load, so an un-optimised photo would make the customer's whole site heavier
 * for no visible benefit (the logo renders at ~28px, the avatar at ~28px). Drawing
 * to a small canvas and re-encoding as WebP typically turns a 40–64 KB upload into
 * a few KB. Enforced here so the config stays tiny regardless of what's uploaded.
 */
async function downscaleImage(file: File, maxPx: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  // WebP where supported (much smaller), else JPEG. PNG only if the source had
  // transparency worth keeping — but a chat avatar/logo at this size rarely does,
  // and JPEG/WebP keep it tiny.
  const webp = canvas.toDataURL("image/webp", 0.85);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85);
}

/** Upload a small image → downscaled data URL (no server infra). */
function ImageUpload({ label, value, maxKb, onChange }: { label: string; value?: string; maxKb: number; onChange: (v: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function pick(file: File) {
    setErr(null);
    if (!/^image\//.test(file.type)) return setErr("Images only");
    // Guard the SOURCE size loosely (a 20MB upload shouldn't be decoded), but the
    // stored size is governed by the downscale, not this.
    if (file.size > 8 * 1024 * 1024) return setErr("Image too large");
    try {
      // Logo shows a touch larger than the avatar; both are tiny on screen.
      const out = await downscaleImage(file, maxKb >= 64 ? 192 : 128);
      if (out.length > maxKb * 1024 * 1.4) return setErr("Couldn't compress that image enough — try a simpler one");
      onChange(out);
    } catch {
      setErr("Couldn't read that image");
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="size-9 shrink-0 rounded-lg border object-cover" />
        ) : (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-2xs text-muted-foreground">—</div>
        )}
        <label className="cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs transition hover:bg-muted">
          Upload
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
        </label>
        {value && (
          <button onClick={() => onChange("")} className="text-xs text-muted-foreground hover:text-destructive">
            Remove
          </button>
        )}
      </div>
      {err && <span className="text-2xs text-destructive">{err}</span>}
    </div>
  );
}

/**
 * Free-text editor for the suggested-question list.
 *
 * The textarea keeps its RAW text locally and only normalizes on the way out.
 * Deriving `value` straight from the array (`arr.join("\n")`) with an onChange that
 * split/trimmed/filtered made Enter impossible to type: the keystroke produced
 * `"a\n"`, `filter(Boolean)` dropped the new empty line, and the value re-rendered
 * as `"a"` — so the caret never reached a second line. Trailing blanks and
 * whitespace still never reach the server; they're just allowed to exist WHILE
 * TYPING. Remounted per widget via `key`, so switching widgets re-seeds the buffer.
 */
function SuggestedQuestions({
  value,
  onChange,
  className,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  className?: string;
}) {
  const [raw, setRaw] = useState(() => value.join("\n"));
  return (
    <textarea
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(
          e.target.value
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, MAX_SUGGESTED_QUESTIONS),
        );
      }}
      rows={3}
      className={className}
    />
  );
}

/** Server caps the list at 6 (webchatwidget.schemas.ts) — keep them in step. */
const MAX_SUGGESTED_QUESTIONS = 6;

/**
 * Pre-chat questions, each BOUND to a real destination.
 *
 * Every question picks where its answer goes — the contact's own Name / Email /
 * Phone, or one of the workspace's contact fields — instead of typing a label the
 * server turned into a field key by guessing. Two things that used to be possible
 * are now impossible: asking for something that lands nowhere an agent looks, and
 * rewording a question into a silently-duplicated second field.
 *
 * "New contact field…" creates a real workspace field (Settings → Contact fields)
 * and binds to it, so it exists for every contact, not just the ones who happen to
 * answer this widget's form.
 */
/** Identity targets — carried by the question's TYPE, not a key, because they
 *  have merge semantics the other columns don't. */
const IDENTITY_TARGETS = [
  { value: "name", label: "Full name" },
  { value: "email", label: "Email address" },
  { value: "phone", label: "Phone number" },
] as const;

function PreChatEditor({
  fields,
  onChange,
  contactFields,
  canCreateFields,
  onFieldCreated,
}: {
  fields: Field[];
  onChange: (f: Field[]) => void;
  contactFields: ContactFieldDefinition[];
  canCreateFields: boolean;
  onFieldCreated: (def: ContactFieldDefinition) => void;
}) {
  const [creatingAt, setCreatingAt] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** One flat value per row: a built-in target, or `field:<key>` for a custom one. */
  function targetOf(f: Field): string {
    return f.type === "text" ? (f.key ? `field:${f.key}` : "") : f.type;
  }
  function setTarget(i: number, value: string) {
    setErr(null);
    if (value === "__new__") {
      setCreatingAt(i);
      setNewLabel("");
      return;
    }
    // Everything under "field:" binds by key — a workspace contact field OR one of
    // the built-in columns (first name, location…), which the API accepts too.
    if (value.startsWith("field:")) {
      const key = value.slice(6);
      const target =
        contactFields.find((d) => d.key === key) ??
        PRECHAT_BUILTIN_TARGETS.find((b) => b.key === key);
      if (!target) return;
      onChange(fields.map((x, j) => (j === i ? { ...x, type: "text", key, label: x.label || target.label } : x)));
      return;
    }
    const identity = IDENTITY_TARGETS.find((b) => b.value === value);
    // An identity target drops the key — the answer goes to its own column.
    onChange(
      fields.map((x, j) =>
        j === i ? { ...x, type: (identity?.value ?? "text") as Field["type"], key: undefined, label: x.label || identity?.label || "" } : x,
      ),
    );
  }

  async function createField(i: number) {
    const label = newLabel.trim();
    if (!label) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await apiFetch("/api/workspace/contact-fields", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res, "Couldn't create the field."));
      const { definition } = (await res.json()) as { definition?: ContactFieldDefinition };
      if (!definition) throw new Error("Couldn't create the field.");
      onFieldCreated(definition);
      onChange(fields.map((x, j) => (j === i ? { ...x, type: "text", key: definition.key, label: x.label || definition.label } : x)));
      setCreatingAt(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't create the field.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {fields.length === 0 && <span className="text-xs text-muted-foreground">No questions — visitors chat right away.</span>}
      {fields.map((f, i) => {
        const bound = f.type === "text" && f.key ? contactFields.find((d) => d.key === f.key) : null;
        // A legacy row (configured before the picker) has no key — its answers land
        // in a field named after the question. Say so, and let them re-point it.
        const unbound = f.type === "text" && !f.key;
        return (
          <div key={f.id ?? i} className="flex min-w-0 flex-col gap-1.5 rounded-lg border p-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <input
                value={f.label}
                onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                placeholder="Question the visitor sees"
                aria-label="Question"
                className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
              />
              <label className="flex shrink-0 items-center gap-1 text-xs">
                <input type="checkbox" checked={f.required} onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
                Required
              </label>
              <button onClick={() => onChange(fields.filter((_, j) => j !== i))} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Remove question">
                ×
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-2xs text-muted-foreground">Saves to</span>
              <select
                value={targetOf(f)}
                aria-label="Where the answer is saved"
                onChange={(e) => setTarget(i, e.target.value)}
                className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1.5 text-sm"
              >
                {unbound && <option value="">{`Custom field “${f.label}” (created on first answer)`}</option>}
                <optgroup label="Contact details">
                  {IDENTITY_TARGETS.map((b) => (
                    <option key={b.value} value={b.value}>{b.label}</option>
                  ))}
                  {PRECHAT_BUILTIN_TARGETS.map((b) => (
                    <option key={b.key} value={`field:${b.key}`}>{b.label}</option>
                  ))}
                </optgroup>
                {contactFields.length > 0 && (
                  <optgroup label="Custom fields">
                    {contactFields.map((d) => (
                      <option key={d.key} value={`field:${d.key}`}>
                        {d.label}
                        {d.type === "select" ? " (choices)" : ""}
                      </option>
                    ))}
                  </optgroup>
                )}
                {canCreateFields && <option value="__new__">+ New contact field…</option>}
              </select>
            </div>
            {bound?.type === "select" && (
              <p className="text-2xs text-muted-foreground">
                Visitors pick from this field&apos;s {bound.options?.length ?? 0} choices — edit them in Settings → Contact fields.
              </p>
            )}
            {unbound && (
              <p className="text-2xs text-amber-600 dark:text-amber-500">
                Not linked to a contact field yet — pick one above so you know exactly where answers land.
              </p>
            )}
            {creatingAt === i && (
              <div className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted/50 p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    value={newLabel}
                    autoFocus
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createField(i); } }}
                    placeholder="Field name, e.g. Business name"
                    aria-label="New contact field name"
                    className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                  />
                  <button onClick={() => void createField(i)} disabled={busy || !newLabel.trim()} className="shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
                    {busy ? "Creating…" : "Create"}
                  </button>
                  <button onClick={() => { setCreatingAt(null); setErr(null); }} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                    Cancel
                  </button>
                </div>
                <p className="text-2xs text-muted-foreground">Added to every contact in this workspace, like any field in Settings → Contact fields.</p>
                {err && <p className="text-2xs text-destructive">{err}</p>}
              </div>
            )}
          </div>
        );
      })}
      {fields.length < 6 && (
        <button
          onClick={() => onChange([...fields, { id: `f_${Math.random().toString(36).slice(2)}`, label: "Email address", type: "email", required: false }])}
          className="self-start text-xs font-medium text-primary"
        >
          + Add question
        </button>
      )}
    </div>
  );
}

/** A faithful mini-render of the widget panel that updates live from the draft. */
function Preview({ widget }: { widget: WebchatWidgetView }) {
  const c = widget.config;
  const theme = c.theme ?? {};
  const primary = /^#[0-9a-f]{6}$/i.test(theme.primaryColor ?? "") ? theme.primaryColor! : BRAND;
  const user = /^#[0-9a-f]{6}$/i.test(theme.userBubbleColor ?? "") ? theme.userBubbleColor! : primary;
  const title = c.headerTitle || widget.name || "Chat";
  const dark =
    c.themeMode === "dark" ||
    (c.themeMode === "auto" && typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const surface = dark ? "#0f172a" : "#fff";
  const surface2 = dark ? "#0b1220" : "#f5f7fb";
  const ink = dark ? "#e8edf6" : "#0f1729";
  // Light ink2 is #5b6a83, not the old #66748c: the muted text sits on
  // --surface2 (#f5f7fb) where #66748c was 4.41:1 — under WCAG AA's 4.5:1
  // (axe `color-contrast`, audit 2026-08-11). #5b6a83 is 5.1:1 there and
  // 5.5:1 on white; the REAL widget (public/widget.js) ships the same value
  // so preview and product stay one look. Dark mode was already 6.8:1.
  const ink2 = dark ? "#93a1b8" : "#5b6a83";
  const border = dark ? "#243244" : "#e6e9f0";
  const font = c.fontFamily === "serif" ? "Georgia, serif" : c.fontFamily === "rounded" ? "ui-rounded, system-ui, sans-serif" : undefined;
  // Match the real widget: it renders every configured question (capped at 6 by the
  // schema), not a hardcoded 3 — the preview was under-reporting.
  const qs = useMemo(() => (c.suggestedQuestions ?? []).slice(0, 6), [c.suggestedQuestions]);
  const launcher = c.launcher ?? "bubble";
  const launcherColor = /^#[0-9a-f]{6}$/i.test(theme.launcherColor ?? "") ? theme.launcherColor! : primary;
  const onLeft = c.position === "left";
  const hideHeader = launcher === "inline" && c.showHeader === false;
  const panel = (
    <div className="w-full max-w-[300px] overflow-hidden rounded-[20px] shadow-xl" style={{ background: surface, border: `1px solid ${border}`, fontFamily: font, color: ink }}>
      {!hideHeader && (
      <div className="flex items-center gap-2.5 px-4 py-3.5" style={{ background: `linear-gradient(135deg, ${primary}, ${primary}cc)`, color: contrastOn(primary) }}>
        <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-white/20 text-sm font-bold">
          {c.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.logoDataUrl} alt="" className="size-full object-cover" />
          ) : (
            // Same two-word initials the real widget renders ("Acme Support" → "AS").
            title.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "•"
          )}
          <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-emerald-400" style={{ boxShadow: `0 0 0 2px ${primary}` }} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold leading-tight">{title}</div>
          {c.headerSubtitle && <div className="truncate text-[11px] opacity-90">{c.headerSubtitle}</div>}
        </div>
      </div>
      )}
      <div className="flex min-h-[210px] flex-col gap-2 p-3.5" style={{ background: surface2 }}>
        {c.welcomeMessage && (
          // Matches the widget: the welcome is a message FROM the team, avatar and
          // all — keep these two in step, they were divergent once already.
          <div className="flex items-end gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: `${primary}22`, color: primary }}>
              {(title.trim()[0] || "C").toUpperCase()}
            </span>
            <div className="max-w-[82%] rounded-2xl rounded-bl-md px-3.5 py-2 text-sm" style={{ background: surface, border: `1px solid ${border}`, color: ink }}>
              {c.welcomeMessage}
            </div>
          </div>
        )}
        {/* Real order: welcome → question pills → the visitor's first message
            (pills disappear once they send — showing them after a sent bubble
            was a state the widget never has). */}
        {qs.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {qs.map((q, i) => (
              <span key={i} className="rounded-full px-2.5 py-1 text-xs" style={{ background: surface, border: `1px solid ${border}`, color: primary }}>
                {q}
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[82%] self-end rounded-2xl rounded-br-md px-3 py-2 text-sm" style={{ background: `linear-gradient(145deg, ${user}, ${user}e0)`, color: contrastOn(user) }}>
          Hi! I have a question.
        </div>
      </div>
      <div className="p-3" style={{ background: surface }}>
        <div className="flex items-center gap-1.5 rounded-3xl px-2 py-1.5" style={{ background: surface2, border: `1.5px solid ${border}` }}>
          <span className="flex-1 truncate px-2 text-xs" style={{ color: ink2 }}>Type a message…</span>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full" style={{ background: primary, color: contrastOn(primary) }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </span>
        </div>
      </div>
      {c.showBranding !== false && (
        <div className="pb-2 text-center text-[10.5px] tracking-wide opacity-75" style={{ background: surface, color: ink2 }}>Powered by Loadless</div>
      )}
    </div>
  );

  // The closed state: how the visitor first sees the widget on the page. This is
  // the launcher — previously absent from the preview, so the launcher colour,
  // label, and position were invisible until you shipped and loaded a real page.
  const bubble = (
    <button
      type="button"
      aria-hidden
      // Decorative preview only — aria-hidden elements must not be reachable
      // by keyboard (axe `aria-hidden-focus`, audit 2026-08-11).
      tabIndex={-1}
      className="flex size-[52px] shrink-0 items-center justify-center rounded-full shadow-lg"
      style={{ background: launcherColor, color: contrastOn(launcherColor) }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-6">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    </button>
  );

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {panel}
      <div className="w-full max-w-[300px]">
        <div className="mb-1.5 text-center text-[11px] font-medium text-muted-foreground">
          {launcher === "inline" ? "Embedded in your page" : launcher === "off" ? "Opens from your own button" : "Closed — how visitors first see it"}
        </div>
        {launcher === "bubble" ? (
          <div className={`flex items-center gap-2 ${onLeft ? "justify-start" : "justify-end"}`}>
            {onLeft && bubble}
            {c.launcherLabel && (
              <span className="rounded-full bg-card px-3 py-2 text-xs font-medium shadow-md" style={{ border: `1px solid ${border}`, color: ink }}>
                {c.launcherLabel}
              </span>
            )}
            {!onLeft && bubble}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed py-3 text-center text-xs text-muted-foreground">
            {launcher === "inline"
              ? "No floating bubble — the chat lives inside a container on your page."
              : "No floating bubble — you open the chat from your own link or button."}
          </div>
        )}
      </div>
    </div>
  );
}
