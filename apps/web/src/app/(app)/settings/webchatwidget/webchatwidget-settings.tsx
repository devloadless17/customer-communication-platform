"use client";

import { useMemo, useState } from "react";
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
    setWidgets((ws) =>
      ws.map((w) => (w.id === id ? { ...w, config: { ...w.config, ...patch } } : w)),
    );
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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title="Website chat"
        description="Embed a chat widget on any website. Each site gets its own named widget so you always know where a chat came from."
        action={
          <button
            onClick={createWidget}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Plus className="size-4" /> New widget
          </button>
        }
      />

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {widgets.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          No widgets yet. Create one to get an embed snippet for your website.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
          {/* widget list */}
          <div className="flex flex-col gap-1">
            {widgets.map((w) => (
              <button
                key={w.id}
                onClick={() => setSelectedId(w.id)}
                className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left transition ${
                  w.id === selectedId ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                  <span className="truncate">{w.name}</span>
                  {!w.isActive && <span className="text-2xs text-muted-foreground">off</span>}
                </span>
                <span className="text-2xs text-muted-foreground">
                  {w.conversationCount} chat{w.conversationCount === 1 ? "" : "s"}
                </span>
              </button>
            ))}
          </div>

          {/* editor + preview */}
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
  const origin = appOrigin || "https://YOUR-APP";
  const scriptTag = buildScript(origin, widget.publicKey, c);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* left: form */}
        <div className="flex flex-col gap-4">
          <Labeled label="Widget name">
            <input
              value={widget.name}
              onChange={(e) => onName(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </Labeled>

          <Labeled label="Header title (shown to visitors)">
            <input
              value={c.headerTitle ?? ""}
              placeholder={widget.name}
              onChange={(e) => onConfig({ headerTitle: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </Labeled>

          <Labeled label="Welcome message">
            <textarea
              value={c.welcomeMessage ?? ""}
              onChange={(e) => onConfig({ welcomeMessage: e.target.value })}
              rows={2}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </Labeled>

          <Labeled label="Header subtitle (under the title)">
            <input
              value={c.headerSubtitle ?? ""}
              placeholder="Typically replies in a few minutes"
              onChange={(e) => onConfig({ headerSubtitle: e.target.value })}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </Labeled>

          <div className="grid grid-cols-3 gap-3">
            <ColorField label="Primary" value={theme.primaryColor} onChange={(v) => onConfig({ theme: { ...theme, primaryColor: v } })} />
            <ColorField label="Launcher" value={theme.launcherColor} onChange={(v) => onConfig({ theme: { ...theme, launcherColor: v } })} />
            <ColorField label="Your bubble" value={theme.userBubbleColor} onChange={(v) => onConfig({ theme: { ...theme, userBubbleColor: v } })} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Labeled label="Font">
              <select value={c.fontFamily ?? "system"} onChange={(e) => onConfig({ fontFamily: e.target.value as "system" | "rounded" | "serif" })} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                <option value="system">System</option>
                <option value="rounded">Rounded</option>
                <option value="serif">Serif</option>
              </select>
            </Labeled>
            <Labeled label="Theme">
              <select value={c.themeMode ?? "light"} onChange={(e) => onConfig({ themeMode: e.target.value as "light" | "dark" | "auto" })} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="auto">Auto (system)</option>
              </select>
            </Labeled>
          </div>

          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-semibold">Branding</p>
            <div className="grid grid-cols-2 gap-3">
              <ImageUpload label="Logo" value={c.logoDataUrl} maxKb={64} onChange={(v) => onConfig({ logoDataUrl: v })} />
              <ImageUpload label="Agent avatar" value={c.agentAvatarDataUrl} maxKb={40} onChange={(v) => onConfig({ agentAvatarDataUrl: v })} />
            </div>
          </div>

          <div className="rounded-lg border p-3">
            <p className="mb-2 text-xs font-semibold">Launcher &amp; placement</p>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="Launcher">
                <select value={c.launcher ?? "bubble"} onChange={(e) => onConfig({ launcher: e.target.value as "bubble" | "off" })} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                  <option value="bubble">Floating bubble</option>
                  <option value="off">Hidden (open via your own link)</option>
                </select>
              </Labeled>
              <Labeled label="Position">
                <select value={c.position ?? "right"} onChange={(e) => onConfig({ position: e.target.value as "right" | "left" })} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </select>
              </Labeled>
            </div>
            <Labeled label="Bubble label (optional)">
              <input value={c.launcherLabel ?? ""} placeholder="e.g. Chat with us" onChange={(e) => onConfig({ launcherLabel: e.target.value })} className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" />
            </Labeled>
          </div>

          <Labeled label="Suggested questions (one per line, max 6)">
            <textarea
              value={(c.suggestedQuestions ?? []).join("\n")}
              onChange={(e) =>
                onConfig({
                  suggestedQuestions: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6),
                })
              }
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </Labeled>

          <PreChatEditor
            fields={c.preChatFields ?? []}
            onChange={(preChatFields) => onConfig({ preChatFields })}
          />

          <Labeled label="Allowed website domains">
            <div className="flex flex-wrap gap-1.5">
              {widget.allowedOrigins.map((o) => (
                <span key={o} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                  {o}
                  <button onClick={() => onOrigins(widget.allowedOrigins.filter((x) => x !== o))} className="text-muted-foreground hover:text-foreground">
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              value={originDraft}
              onChange={(e) => setOriginDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const v = originDraft.trim();
                  if (v && !widget.allowedOrigins.includes(v)) onOrigins([...widget.allowedOrigins, v]);
                  setOriginDraft("");
                }
              }}
              placeholder="example.com or *.example.com — Enter to add"
              className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-2xs text-muted-foreground">
              Leave empty to allow any site (not recommended). localhost is always allowed for testing.
            </p>
          </Labeled>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.showBranding !== false} onChange={(e) => onConfig({ showBranding: e.target.checked })} />
            Show “Powered by” footer
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={widget.isActive} onChange={(e) => onActive(e.target.checked)} />
            Active
          </label>
        </div>

        {/* right: live preview */}
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium text-muted-foreground">Live preview</p>
          <Preview widget={widget} />
        </div>
      </div>

      {/* embed snippets — one per deploy mode */}
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
        <div>
          <p className="text-sm font-medium">Install on your website</p>
          <p className="text-xs text-muted-foreground">
            Public key: <code>{widget.publicKey}</code>
          </p>
        </div>

        {(c.launcher ?? "bubble") === "off" ? (
          <>
            <CopyBox
              title="1) Add the widget (bubble hidden)"
              hint="Paste before &lt;/body&gt; on every page."
              code={scriptTag}
            />
            <CopyBox
              title="2) Open it from any link or button"
              hint="Wire your own element to the widget."
              code={`<a href="#" onclick="CCPWebchat.open();return false">Chat with us</a>`}
            />
          </>
        ) : (
          <CopyBox
            title="Floating bubble"
            hint="Paste before &lt;/body&gt; on every page — a chat bubble appears."
            code={scriptTag}
          />
        )}

        <CopyBox
          title="Inline — embed inside a page section"
          hint="Renders the chat inside your container (always open)."
          code={`<div id="ccp-chat" style="height:600px;max-width:440px"></div>\n<script src="${origin}/widget.js" data-webchat-key="${widget.publicKey}" data-webchat-target="#ccp-chat" defer></script>`}
        />
      </div>

      <div className="flex items-center justify-between">
        <button onClick={onDelete} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive disabled:opacity-50">
          <Trash2 className="size-4" /> Delete
        </button>
        <button onClick={onSave} disabled={busy} className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

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
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold">{title}</p>
      <p className="text-2xs text-muted-foreground">{hint}</p>
      <div className="flex items-start gap-2">
        <code className="flex-1 overflow-x-auto whitespace-pre rounded-md bg-muted px-3 py-2 text-2xs">{code}</code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-2 text-xs"
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
    if (file.size > maxKb * 1024) { setErr(`Max ${maxKb} KB`); return; }
    if (!/^image\//.test(file.type)) { setErr("Images only"); return; }
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
          <img src={value} alt="" className="size-9 rounded-md border object-cover" />
        ) : (
          <div className="flex size-9 items-center justify-center rounded-md border bg-muted text-2xs text-muted-foreground">—</div>
        )}
        <label className="cursor-pointer rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted">
          Upload
          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
        </label>
        {value && (
          <button onClick={() => onChange("")} className="text-xs text-muted-foreground hover:text-destructive">Remove</button>
        )}
      </div>
      {err && <span className="text-2xs text-destructive">{err}</span>}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  const v = value && /^#[0-9a-f]{6}$/i.test(value) ? value : BRAND;
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      <input type="color" value={v} onChange={(e) => onChange(e.target.value)} className="h-9 w-full cursor-pointer rounded-md border bg-background" />
    </label>
  );
}

function PreChatEditor({ fields, onChange }: { fields: Field[]; onChange: (f: Field[]) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">Pre-chat form (optional — ask before chat)</span>
      {fields.map((f, i) => (
        <div key={f.id ?? i} className="flex items-center gap-2">
          <input
            value={f.label}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            placeholder="Label"
            className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm"
          />
          <select
            value={f.type}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, type: e.target.value as Field["type"] } : x)))}
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="name">Name</option>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="text">Text</option>
          </select>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={f.required} onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />
            req
          </label>
          <button onClick={() => onChange(fields.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive">
            ×
          </button>
        </div>
      ))}
      {fields.length < 6 && (
        <button
          onClick={() =>
            onChange([
              ...fields,
              { id: `f_${Math.random().toString(36).slice(2)}`, label: "Email", type: "email", required: false },
            ])
          }
          className="self-start text-xs text-primary"
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
    <div className="w-[330px] overflow-hidden rounded-[20px] shadow-xl" style={{ background: surface, border: `1px solid ${border}`, fontFamily: font, color: ink }}>
      <div className="flex items-center gap-2.5 px-4 py-3.5" style={{ background: `linear-gradient(135deg, ${primary}, ${primary}cc)`, color: contrastOn(primary) }}>
        <span className="relative flex size-9 items-center justify-center overflow-hidden rounded-[11px] bg-white/20 text-sm font-bold">
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
      <div className="flex min-h-[220px] flex-col gap-2 p-3.5" style={{ background: surface2 }}>
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
          <span className="flex-1 px-2 text-xs" style={{ color: ink2 }}>Type a message…</span>
          <span className="flex size-8 items-center justify-center rounded-full text-sm" style={{ background: primary, color: contrastOn(primary) }}>➤</span>
        </div>
      </div>
      {c.showBranding !== false && (
        <div className="pb-2 text-center text-[11px]" style={{ background: surface, color: ink2 }}>⚡ Powered by chat</div>
      )}
    </div>
  );
}
