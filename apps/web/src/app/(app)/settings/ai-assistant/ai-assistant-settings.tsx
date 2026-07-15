"use client";

import { useState, type ReactNode } from "react";

import { PageHeader } from "@/components/layouts/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

// Shape is intentionally loose — mirrors the API row; the form only reads/writes
// the fields it renders. configVersion 0 + id null = never saved yet.
export interface AiConfig {
  id: string | null;
  enabled: boolean;
  configVersion: number;
  [k: string]: unknown;
}
export interface AiDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: "processing" | "ready" | "failed" | "disabled";
  enabled: boolean;
  error: string | null;
  chunkCount: number;
  createdAt: string;
}

const TABS = [
  ["identity", "Company Identity"],
  ["business", "Business Details"],
  ["hours", "Opening Hours"],
  ["languages", "Languages & Dialect"],
  ["tone", "Tone & Reply Behavior"],
  ["voice", "Voice"],
  ["knowledge", "Knowledge Files"],
] as const;
type TabKey = (typeof TABS)[number][0];

const DAYS: Array<[string, string]> = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];

export function AiAssistantSettings({
  initialConfig,
  initialDocuments,
}: {
  initialConfig: AiConfig;
  initialDocuments: AiDocument[];
}) {
  const [form, setForm] = useState<Record<string, unknown>>({ ...initialConfig });
  const [version, setVersion] = useState<number>(initialConfig.configVersion ?? 0);
  const [tab, setTab] = useState<TabKey>("identity");
  const [saving, setSaving] = useState(false);
  const [documents, setDocuments] = useState<AiDocument[]>(initialDocuments);

  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));
  const str = (key: string) => (form[key] == null ? "" : String(form[key]));
  const bool = (key: string) => form[key] === true;
  const num = (key: string, fallback: number) =>
    typeof form[key] === "number" ? (form[key] as number) : fallback;

  async function save() {
    setSaving(true);
    try {
      const { id: _id, configVersion: _cv, createdAt: _c, updatedAt: _u, teamId: _t, ...editable } =
        form as Record<string, unknown>;
      const res = await apiFetch("/api/team/ai-assistant", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...editable, expectedConfigVersion: version }),
      });
      const data = (await res.json().catch(() => ({}))) as { config?: AiConfig; error?: string };
      if (!res.ok || !data.config) {
        if (res.status === 409) {
          toast.error("Someone else changed these settings — reload and try again.");
        } else {
          toast.error(data.error ? `Save failed: ${data.error}` : "Save failed");
        }
        return;
      }
      setForm({ ...data.config });
      setVersion(data.config.configVersion ?? version + 1);
      toast.success("AI Assistant settings saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="AI Assistant"
        description="Company profile, knowledge, and behavior for the native AI auto-responder."
        action={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Enabled</span>
              <Switch checked={bool("enabled")} onCheckedChange={(v) => set("enabled", v)} />
            </label>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      />

      {/* Hand-rolled tabs (no tabs primitive in the design system). */}
      <div role="tablist" className="mt-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-t-md px-3 py-2 text-sm transition-colors ${
              tab === key
                ? "border-b-2 border-primary font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="py-6">
        {tab === "identity" && (
          <Grid>
            <Field label="Company name"><TextInput value={str("companyName")} onChange={(v) => set("companyName", v)} /></Field>
            <Field label="Industry"><TextInput value={str("industry")} onChange={(v) => set("industry", v)} /></Field>
            <Field label="Website"><TextInput value={str("website")} onChange={(v) => set("website", v)} /></Field>
            <Field label="Phone"><TextInput value={str("phone")} onChange={(v) => set("phone", v)} /></Field>
            <Field label="Short description" full><Textarea rows={2} value={str("shortDescription")} onChange={(e) => set("shortDescription", e.target.value)} /></Field>
            <Field label="Full description" full><Textarea rows={5} value={str("fullDescription")} onChange={(e) => set("fullDescription", e.target.value)} /></Field>
            <Field label="Service areas (comma-separated)" full>
              <TextInput
                value={(Array.isArray(form.serviceAreas) ? (form.serviceAreas as string[]) : []).join(", ")}
                onChange={(v) => set("serviceAreas", v.split(",").map((s) => s.trim()).filter(Boolean))}
              />
            </Field>
            <Field label="Locations" full>
              <RowList
                rows={(form.locations as Array<Record<string, string>>) ?? []}
                columns={[["label", "Label"], ["address", "Address"]]}
                onChange={(rows) => set("locations", rows)}
              />
            </Field>
          </Grid>
        )}

        {tab === "business" && (
          <Grid>
            <Field label="Products" full><Textarea rows={3} value={str("products")} onChange={(e) => set("products", e.target.value)} /></Field>
            <Field label="Services" full><Textarea rows={3} value={str("services")} onChange={(e) => set("services", e.target.value)} /></Field>
            <Field label="Pricing notes" full><Textarea rows={2} value={str("pricingNotes")} onChange={(e) => set("pricingNotes", e.target.value)} /></Field>
            <Field label="Payment methods"><TextInput value={str("paymentMethods")} onChange={(v) => set("paymentMethods", v)} /></Field>
            <Field label="Delivery policy"><TextInput value={str("deliveryPolicy")} onChange={(v) => set("deliveryPolicy", v)} /></Field>
            <Field label="Return policy"><TextInput value={str("returnPolicy")} onChange={(v) => set("returnPolicy", v)} /></Field>
            <Field label="Booking rules"><TextInput value={str("bookingRules")} onChange={(v) => set("bookingRules", v)} /></Field>
            <Field label="Restrictions" full><Textarea rows={2} value={str("restrictions")} onChange={(e) => set("restrictions", e.target.value)} /></Field>
            <Field label="Human escalation instructions" full><Textarea rows={3} value={str("escalationInstructions")} onChange={(e) => set("escalationInstructions", e.target.value)} /></Field>
            <Field label="FAQs" full>
              <RowList
                rows={(form.faqs as Array<Record<string, string>>) ?? []}
                columns={[["q", "Question"], ["a", "Answer"]]}
                onChange={(rows) => set("faqs", rows)}
              />
            </Field>
          </Grid>
        )}

        {tab === "hours" && (
          <Grid>
            <Field label="Timezone"><TextInput value={str("timezone") || "Asia/Beirut"} onChange={(v) => set("timezone", v)} /></Field>
            <Field label="After-hours behavior" full><Textarea rows={2} value={str("afterHoursBehavior")} onChange={(e) => set("afterHoursBehavior", e.target.value)} /></Field>
            <Field label="Weekly schedule" full>
              <WeeklySchedule value={(form.weeklySchedule as Record<string, Array<{ open: string; close: string }>>) ?? {}} onChange={(v) => set("weeklySchedule", v)} />
            </Field>
            <Field label="Holidays" full>
              <RowList rows={(form.holidays as Array<Record<string, string>>) ?? []} columns={[["date", "Date (YYYY-MM-DD)"], ["label", "Label"]]} onChange={(rows) => set("holidays", rows)} />
            </Field>
            <Field label="Exceptions" full>
              <RowList rows={(form.scheduleExceptions as Array<Record<string, string>>) ?? []} columns={[["date", "Date"], ["open", "Open"], ["close", "Close"]]} onChange={(rows) => set("scheduleExceptions", rows)} />
            </Field>
          </Grid>
        )}

        {tab === "languages" && (
          <Grid>
            <Field label="Supported languages (comma-separated codes)" full>
              <TextInput
                value={(Array.isArray(form.supportedLanguages) ? (form.supportedLanguages as string[]) : []).join(", ")}
                onChange={(v) => set("supportedLanguages", v.split(",").map((s) => s.trim()).filter(Boolean))}
              />
            </Field>
            <Field label="Default language"><TextInput value={str("defaultLanguage") || "ar"} onChange={(v) => set("defaultLanguage", v)} /></Field>
            <Field label="Language policy">
              <SelectInput value={str("languagePolicy") || "match_customer"} onChange={(v) => set("languagePolicy", v)} options={[["match_customer", "Match customer"], ["default_language", "Always default"], ["specific", "Specific language"]]} />
            </Field>
            {str("languagePolicy") === "specific" && (
              <Field label="Specific language"><TextInput value={str("specificLanguage")} onChange={(v) => set("specificLanguage", v)} /></Field>
            )}
            <Field label="Script policy">
              <SelectInput value={str("scriptPolicy") || "match_customer"} onChange={(v) => set("scriptPolicy", v)} options={[["match_customer", "Match customer"], ["arabic", "Arabic script"], ["latin", "Latin script"]]} />
            </Field>
            <Field label="Emoji policy">
              <SelectInput value={str("emojiPolicy") || "sparing"} onChange={(v) => set("emojiPolicy", v)} options={[["none", "None"], ["sparing", "Sparing"], ["expressive", "Expressive"]]} />
            </Field>
            <SwitchRow label="Lebanese dialect" checked={bool("lebaneseDialect")} onChange={(v) => set("lebaneseDialect", v)} />
            <SwitchRow label="Allow Arabizi (Latin-script Lebanese)" checked={bool("allowArabizi")} onChange={(v) => set("allowArabizi", v)} />
            <SwitchRow label="Code-switching (mix AR/FR/EN)" checked={bool("codeSwitching")} onChange={(v) => set("codeSwitching", v)} />
            <Field label="Lebanese style guidance" full><Textarea rows={2} value={str("lebaneseStyle")} onChange={(e) => set("lebaneseStyle", e.target.value)} /></Field>
          </Grid>
        )}

        {tab === "tone" && (
          <Grid>
            <Field label="Tone"><TextInput value={str("tone") || "friendly"} onChange={(v) => set("tone", v)} /></Field>
            <Field label="Reply length">
              <SelectInput value={str("replyLength") || "balanced"} onChange={(v) => set("replyLength", v)} options={[["short", "Short"], ["balanced", "Balanced"], ["detailed", "Detailed"]]} />
            </Field>
            <Field label="Auto-reply mode">
              <SelectInput value={str("autoReplyMode") || "auto_send"} onChange={(v) => set("autoReplyMode", v)} options={[["auto_send", "Auto-send"], ["draft", "Draft for approval"], ["hybrid", "Hybrid (draft in-hours, auto after-hours)"]]} />
            </Field>
            <Field label="Confidence threshold (0–1)"><NumberInput value={num("confidenceThreshold", 0.55)} step={0.05} min={0} max={1} onChange={(v) => set("confidenceThreshold", v)} /></Field>
            <Field label="Max auto-replies per conversation (0 = unlimited)"><NumberInput value={num("maxAutoRepliesPerConv", 0)} step={1} min={0} onChange={(v) => set("maxAutoRepliesPerConv", v)} /></Field>
            <Field label="Human takeover behavior"><TextInput value={str("humanTakeoverBehavior") || "cancel_and_yield"} onChange={(v) => set("humanTakeoverBehavior", v)} /></Field>
            <SwitchRow label="Match customer tone" checked={bool("matchCustomerTone")} onChange={(v) => set("matchCustomerTone", v)} />
            <Field label="Custom instructions" full><Textarea rows={4} value={str("customInstructions")} onChange={(e) => set("customInstructions", e.target.value)} /></Field>
          </Grid>
        )}

        {tab === "voice" && (
          <Grid>
            <SwitchRow label="Transcribe incoming voice notes" checked={bool("incomingTranscription")} onChange={(v) => set("incomingTranscription", v)} />
            <SwitchRow label="Save transcript text" checked={bool("saveTranscript")} onChange={(v) => set("saveTranscript", v)} />
            <Field label="Reply channel mode">
              <SelectInput value={str("replyChannelMode") || "text"} onChange={(v) => set("replyChannelMode", v)} options={[["text", "Text only"], ["voice", "Voice only"], ["match_customer", "Match customer"], ["text_and_voice", "Text + voice"]]} />
            </Field>
            <Field label="Voice">
              <SelectInput value={str("voiceId") || "alloy"} onChange={(v) => set("voiceId", v)} options={OPENAI_VOICES.map((v) => [v, v] as [string, string])} />
            </Field>
            <Field label="Voice language"><TextInput value={str("voiceLanguage") || "ar"} onChange={(v) => set("voiceLanguage", v)} /></Field>
            <Field label="Voice speed"><NumberInput value={num("voiceSpeed", 1)} step={0.05} min={0.25} max={4} onChange={(v) => set("voiceSpeed", v)} /></Field>
            <Field label="Max voice duration (sec)"><NumberInput value={num("maxVoiceDurationSec", 60)} step={5} min={1} max={600} onChange={(v) => set("maxVoiceDurationSec", v)} /></Field>
            <SwitchRow label="Fall back to text on any voice failure" checked={bool("voiceTextFallback")} onChange={(v) => set("voiceTextFallback", v)} />
            <p className="col-span-2 text-xs text-muted-foreground">
              Arabic dialect quality is not guaranteed — always keep the text fallback on. Voice reply
              text is generated in Arabic script for synthesis; the canonical reply text is preserved.
            </p>
          </Grid>
        )}

        {tab === "knowledge" && (
          <KnowledgeFiles documents={documents} setDocuments={setDocuments} />
        )}
      </div>
    </div>
  );
}

// --- field primitives ---
function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4">{children}</div>;
}
function Field({ label, full, children }: { label: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={full ? "col-span-2" : "col-span-2 sm:col-span-1"}>
      <label className="mb-1 block text-sm font-medium text-foreground">{label}</label>
      {children}
    </div>
  );
}
function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <Input value={value} onChange={(e) => onChange(e.target.value)} />;
}
function NumberInput({ value, onChange, step, min, max }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <Input
      type="number"
      value={value}
      step={step}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
function SelectInput({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </Select>
  );
}
function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="col-span-2 flex items-center justify-between rounded-md border border-border px-3 py-2 sm:col-span-1">
      <span className="text-sm">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function RowList({
  rows,
  columns,
  onChange,
}: {
  rows: Array<Record<string, string>>;
  columns: Array<[string, string]>;
  onChange: (rows: Array<Record<string, string>>) => void;
}) {
  const list = Array.isArray(rows) ? rows : [];
  return (
    <div className="space-y-2">
      {list.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          {columns.map(([key, ph]) => (
            <Input
              key={key}
              placeholder={ph}
              value={row[key] ?? ""}
              onChange={(e) => {
                const next = list.slice();
                next[i] = { ...next[i], [key]: e.target.value };
                onChange(next);
              }}
            />
          ))}
          <Button variant="ghost" size="sm" onClick={() => onChange(list.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => onChange([...list, {}])}>
        + Add
      </Button>
    </div>
  );
}

function WeeklySchedule({
  value,
  onChange,
}: {
  value: Record<string, Array<{ open: string; close: string }>>;
  onChange: (v: Record<string, Array<{ open: string; close: string }>>) => void;
}) {
  const get = (day: string) => value?.[day]?.[0] ?? { open: "", close: "" };
  const setDay = (day: string, range: { open: string; close: string }) => {
    const next = { ...(value ?? {}) };
    if (range.open && range.close) next[day] = [range];
    else delete next[day];
    onChange(next);
  };
  return (
    <div className="space-y-1">
      {DAYS.map(([key, label]) => {
        const r = get(key);
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="w-24 text-sm text-muted-foreground">{label}</span>
            <Input type="time" value={r.open} onChange={(e) => setDay(key, { ...r, open: e.target.value })} />
            <span className="text-muted-foreground">–</span>
            <Input type="time" value={r.close} onChange={(e) => setDay(key, { ...r, close: e.target.value })} />
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">Leave a day blank to mark it closed.</p>
    </div>
  );
}

function KnowledgeFiles({
  documents,
  setDocuments,
}: {
  documents: AiDocument[];
  setDocuments: (d: AiDocument[]) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function refresh() {
    const res = await apiFetch("/api/team/ai-assistant/documents");
    if (!res.ok) return;
    const data = (await res.json()) as { documents?: AiDocument[] };
    if (data.documents) setDocuments(data.documents);
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch("/api/team/ai-assistant/documents", { method: "POST", body: fd });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ? `Upload failed: ${data.error}` : "Upload failed");
        return;
      }
      toast.success("Uploaded — processing…");
      await refresh();
    } finally {
      setUploading(false);
    }
  }

  async function toggle(doc: AiDocument) {
    const res = await apiFetch(`/api/team/ai-assistant/documents/${doc.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !doc.enabled }),
    });
    if (res.ok) await refresh();
  }
  async function reprocess(doc: AiDocument) {
    const res = await apiFetch(`/api/team/ai-assistant/documents/${doc.id}/reprocess`, { method: "POST" });
    if (res.ok) {
      toast.success("Reprocessing…");
      await refresh();
    }
  }
  async function remove(doc: AiDocument) {
    const res = await apiFetch(`/api/team/ai-assistant/documents/${doc.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Deleted");
      await refresh();
    }
  }

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground hover:bg-muted/40">
        <span>{uploading ? "Uploading…" : "Click to upload a knowledge file (PDF, DOCX, TXT, MD, CSV, JSON — max 10 MB)"}</span>
        <input
          type="file"
          className="hidden"
          accept=".pdf,.docx,.txt,.md,.csv,.json"
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
      </label>

      <div className="space-y-2">
        {documents.length === 0 && <p className="text-sm text-muted-foreground">No knowledge files yet.</p>}
        {documents.map((doc) => (
          <div key={doc.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{doc.filename}</div>
              <div className="text-xs text-muted-foreground">
                <StatusBadge status={doc.status} /> · {doc.chunkCount} chunks
                {doc.error ? ` · ${doc.error}` : ""}
              </div>
            </div>
            <label className="flex items-center gap-1 text-xs">
              <Switch checked={doc.enabled} onCheckedChange={() => void toggle(doc)} />
            </label>
            <Button variant="ghost" size="sm" onClick={() => void reprocess(doc)}>Reprocess</Button>
            <Button variant="ghost" size="sm" onClick={() => void remove(doc)}>Delete</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AiDocument["status"] }) {
  const color =
    status === "ready"
      ? "text-green-600"
      : status === "failed"
        ? "text-red-600"
        : status === "disabled"
          ? "text-muted-foreground"
          : "text-amber-600";
  return <span className={color}>{status}</span>;
}
