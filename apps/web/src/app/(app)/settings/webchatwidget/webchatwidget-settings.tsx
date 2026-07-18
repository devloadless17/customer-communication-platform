"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy, Plus, Trash2 } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { PageHeader } from "@/components/layouts/page-header";
import type { WebchatWidgetView } from "@/lib/api/queries";

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
}: {
  widgets: WebchatWidgetView[];
  canManage: boolean;
  appOrigin: string;
}) {
  const [widgets, setWidgets] = useState<WebchatWidgetView[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const res = await apiFetch("/api/team/webchatwidget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Website ${widgets.length + 1}`, allowedOrigins: [] }),
      });
      const data = (await res.json()) as { widget?: WebchatWidgetView; error?: string };
      if (!res.ok || !data.widget) throw new Error(data.error || "create failed");
      setWidgets((ws) => [...ws, data.widget!]);
      setSelectedId(data.widget.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  async function save(w: WebchatWidgetView) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/team/webchatwidget/${w.id}`, {
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
          preChatFields: w.config.preChatFields ?? [],
          showBranding: w.config.showBranding ?? true,
          logoDataUrl: w.config.logoDataUrl ?? "",
          agentAvatarDataUrl: w.config.agentAvatarDataUrl ?? "",
          fontFamily: w.config.fontFamily ?? "system",
          themeMode: w.config.themeMode ?? "light",
          soundEnabled: w.config.soundEnabled ?? false,
          launcher: w.config.launcher ?? "bubble",
          position: w.config.position ?? "right",
          launcherLabel: w.config.launcherLabel ?? "",
        }),
      });
      const data = (await res.json()) as { widget?: WebchatWidgetView; error?: string };
      if (!res.ok || !data.widget) throw new Error(data.error || "save failed");
      patchLocal(w.id, data.widget);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this widget? Existing conversations keep their history.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/team/webchatwidget/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      setWidgets((ws) => ws.filter((w) => w.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
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

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* form */}
        <div className="flex min-w-0 flex-col gap-5">
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
            <Field label="Suggested questions" hint="One per line, up to 6.">
              <textarea
                value={(c.suggestedQuestions ?? []).join("\n")}
                onChange={(e) => onConfig({ suggestedQuestions: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6) })}
                rows={3}
                className={`${inputCls} resize-y`}
              />
            </Field>
          </Section>

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

          <Section title="Branding">
            <div className="grid grid-cols-2 gap-4">
              <ImageUpload label="Logo" value={c.logoDataUrl} maxKb={64} onChange={(v) => onConfig({ logoDataUrl: v })} />
              <ImageUpload label="Agent avatar" value={c.agentAvatarDataUrl} maxKb={40} onChange={(v) => onConfig({ agentAvatarDataUrl: v })} />
            </div>
          </Section>

          <Section title="Launcher & placement">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Launcher">
                <select value={c.launcher ?? "bubble"} onChange={(e) => onConfig({ launcher: e.target.value as "bubble" | "off" })} className={inputCls}>
                  <option value="bubble">Floating bubble</option>
                  <option value="off">Hidden (open from a link)</option>
                </select>
              </Field>
              <Field label="Position">
                <select value={c.position ?? "right"} onChange={(e) => onConfig({ position: e.target.value as "right" | "left" })} className={inputCls}>
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </select>
              </Field>
            </div>
            <Field label="Bubble label" hint="Optional text beside the bubble.">
              <input value={c.launcherLabel ?? ""} placeholder="e.g. Chat with us" onChange={(e) => onConfig({ launcherLabel: e.target.value })} className={inputCls} />
            </Field>
          </Section>

          <Section title="Pre-chat form" desc="Optionally ask for a few details before the chat starts.">
            <PreChatEditor fields={c.preChatFields ?? []} onChange={(preChatFields) => onConfig({ preChatFields })} />
          </Section>

          <Section title="Allowed domains" desc="Only these sites may embed the widget. localhost is always allowed for testing.">
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

          <Section title="Behavior">
            <Toggle checked={c.soundEnabled === true} onChange={(v) => onConfig({ soundEnabled: v })} label="Play a chime on new messages" hint="A subtle sound when an agent replies." />
            <Toggle checked={c.showBranding !== false} onChange={(v) => onConfig({ showBranding: v })} label="Show “Powered by” footer" />
            <Toggle checked={widget.isActive} onChange={onActive} label="Active" hint="Inactive widgets stop accepting new chats." />
          </Section>
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
      <Section title="Install on your website" desc={`Public key: ${widget.publicKey}`}>
        {(c.launcher ?? "bubble") === "off" ? (
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
          title="Inline — embed inside a page section"
          hint="Renders the chat inside your container (always open)."
          code={`<div id="ccp-chat" style="height:600px;max-width:440px"></div>\n<script src="${origin}/widget.js" data-webchat-key="${widget.publicKey}" data-webchat-target="#ccp-chat" defer></script>`}
        />
      </Section>

      <div className="flex items-center justify-between">
        <button onClick={onDelete} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-2 text-sm text-destructive transition hover:bg-destructive/5 disabled:opacity-50">
          <Trash2 className="size-4" /> Delete
        </button>
        <button onClick={onSave} disabled={busy} className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ── small building blocks ────────────────────────────────────────────────────

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
  const attrs = [`data-webchat-key="${key}"`];
  if ((c.position ?? "right") === "left") attrs.push(`data-webchat-position="left"`);
  if (c.launcherLabel) attrs.push(`data-webchat-label="${c.launcherLabel}"`);
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

/** Upload a small image → data URL (no server infra). Size-capped. */
function ImageUpload({ label, value, maxKb, onChange }: { label: string; value?: string; maxKb: number; onChange: (v: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  function pick(file: File) {
    setErr(null);
    if (file.size > maxKb * 1024) return setErr(`Max ${maxKb} KB`);
    if (!/^image\//.test(file.type)) return setErr("Images only");
    const r = new FileReader();
    r.onload = () => onChange(String(r.result || ""));
    r.readAsDataURL(file);
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

function PreChatEditor({ fields, onChange }: { fields: Field[]; onChange: (f: Field[]) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {fields.length === 0 && <span className="text-xs text-muted-foreground">No fields — visitors chat right away.</span>}
      {fields.map((f, i) => (
        <div key={f.id ?? i} className="flex min-w-0 items-center gap-2">
          <input
            value={f.label}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            placeholder="Label"
            className="min-w-0 flex-1 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
          />
          <select
            value={f.type}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, type: e.target.value as Field["type"] } : x)))}
            className="shrink-0 rounded-lg border bg-background px-2 py-1.5 text-sm"
          >
            <option value="name">Name</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="text">Text</option>
          </select>
          <label className="flex shrink-0 items-center gap-1 text-xs">
            <input type="checkbox" checked={f.required} onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
            req
          </label>
          <button onClick={() => onChange(fields.filter((_, j) => j !== i))} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Remove field">
            ×
          </button>
        </div>
      ))}
      {fields.length < 6 && (
        <button
          onClick={() => onChange([...fields, { id: `f_${Math.random().toString(36).slice(2)}`, label: "Email", type: "email", required: false }])}
          className="self-start text-xs font-medium text-primary"
        >
          + Add field
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
  const inb = dark ? "#1e293b" : "#fff";
  const ink = dark ? "#e8edf6" : "#0f1729";
  const ink2 = dark ? "#93a1b8" : "#66748c";
  const border = dark ? "#243244" : "#e6e9f0";
  const font = c.fontFamily === "serif" ? "Georgia, serif" : c.fontFamily === "rounded" ? "ui-rounded, system-ui, sans-serif" : undefined;
  const qs = useMemo(() => (c.suggestedQuestions ?? []).slice(0, 3), [c.suggestedQuestions]);
  return (
    <div className="w-full max-w-[300px] overflow-hidden rounded-[20px] shadow-xl" style={{ background: surface, border: `1px solid ${border}`, fontFamily: font, color: ink }}>
      <div className="flex items-center gap-2.5 px-4 py-3.5" style={{ background: `linear-gradient(135deg, ${primary}, ${primary}cc)`, color: contrastOn(primary) }}>
        <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-white/20 text-sm font-bold">
          {c.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={c.logoDataUrl} alt="" className="size-full object-cover" />
          ) : (
            (title.trim()[0] || "C").toUpperCase()
          )}
          <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-emerald-400" style={{ boxShadow: `0 0 0 2px ${primary}` }} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-bold leading-tight">{title}</div>
          {c.headerSubtitle && <div className="truncate text-[11px] opacity-90">{c.headerSubtitle}</div>}
        </div>
      </div>
      <div className="flex min-h-[210px] flex-col gap-2 p-3.5" style={{ background: surface2 }}>
        {c.welcomeMessage && (
          <div className="max-w-[82%] self-start rounded-2xl rounded-bl-md px-3 py-2 text-sm" style={{ background: inb, border: `1px solid ${border}`, color: ink }}>
            {c.welcomeMessage}
          </div>
        )}
        <div className="max-w-[82%] self-end rounded-2xl rounded-br-md px-3 py-2 text-sm" style={{ background: `linear-gradient(145deg, ${user}, ${user}e0)`, color: contrastOn(user) }}>
          Hi! I have a question.
        </div>
        {qs.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {qs.map((q, i) => (
              <span key={i} className="rounded-full px-2.5 py-1 text-xs" style={{ background: surface, border: `1px solid ${border}`, color: primary }}>
                {q}
              </span>
            ))}
          </div>
        )}
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
        <div className="pb-2 text-center text-[11px]" style={{ background: surface, color: ink2 }}>Powered by chat</div>
      )}
    </div>
  );
}
