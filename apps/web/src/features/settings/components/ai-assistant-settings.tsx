"use client";

import { useRef, useState, type ReactNode } from "react";

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
// TTS voices. The ar-LB (Azure) voices are the ONLY authentically Lebanese
// options — they need AZURE_SPEECH_KEY set on the server; if it isn't, picking
// one falls back to text. The OpenAI voices are English-first (not truly
// Lebanese); their descriptions are the commonly PERCEIVED character (OpenAI
// doesn't officially assign gender). Value = the voice id the API expects.
const OPENAI_VOICES: Array<[string, string]> = [
  ["ar-LB-LaylaNeural", "🇱🇧 Layla — Lebanese, female (Azure)"],
  ["ar-LB-RamiNeural", "🇱🇧 Rami — Lebanese, male (Azure)"],
  ["alloy", "Alloy — neutral, balanced (OpenAI)"],
  ["ash", "Ash — male, expressive (OpenAI)"],
  ["ballad", "Ballad — male, warm & emotive (OpenAI)"],
  ["coral", "Coral — female, warm & friendly (OpenAI)"],
  ["echo", "Echo — male, calm & clear (OpenAI)"],
  ["fable", "Fable — male, British, storytelling (OpenAI)"],
  ["onyx", "Onyx — male, deep & authoritative (OpenAI)"],
  ["nova", "Nova — female, bright & energetic (OpenAI)"],
  ["sage", "Sage — female, calm & gentle (OpenAI)"],
  ["shimmer", "Shimmer — female, soft & warm (OpenAI)"],
];

// Broad language set so the assistant can be told it speaks more than ar/en —
// the selected codes are injected verbatim into the model prompt
// ("Supported languages: …", see prompt-builder). Codes are ISO 639-1.
const LANGUAGES: Array<[string, string]> = [
  ["ar", "Arabic"], ["en", "English"], ["fr", "French"], ["es", "Spanish"],
  ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"],
  ["ru", "Russian"], ["tr", "Turkish"], ["fa", "Persian (Farsi)"], ["ur", "Urdu"],
  ["hi", "Hindi"], ["bn", "Bengali"], ["zh", "Chinese"], ["ja", "Japanese"],
  ["ko", "Korean"], ["id", "Indonesian"], ["ms", "Malay"], ["th", "Thai"],
  ["vi", "Vietnamese"], ["el", "Greek"], ["pl", "Polish"],
  ["uk", "Ukrainian"], ["ro", "Romanian"], ["sv", "Swedish"], ["da", "Danish"],
  ["fi", "Finnish"], ["no", "Norwegian"], ["cs", "Czech"], ["hu", "Hungarian"],
  ["sw", "Swahili"], ["ha", "Hausa"], ["am", "Amharic"], ["tl", "Tagalog"],
];
const VOICE_SPEEDS: Array<[string, string]> = [
  ["0.5", "0.5× (slow)"], ["0.75", "0.75×"], ["1", "1× (normal)"],
  ["1.25", "1.25×"], ["1.5", "1.5×"], ["2", "2× (fast)"],
];
const TONES: Array<[string, string]> = [
  ["friendly", "Friendly"], ["professional", "Professional"], ["casual", "Casual"],
  ["formal", "Formal"], ["warm", "Warm"], ["empathetic", "Empathetic"],
  ["enthusiastic", "Enthusiastic"], ["playful", "Playful"], ["concise", "Concise & direct"],
];
const TAKEOVER: Array<[string, string]> = [
  ["cancel_and_yield", "Cancel the AI turn and hand off to the human"],
];
// Full IANA zone list when the runtime supports it (all modern browsers do),
// with a small MENA/EU/US fallback for older engines. Typed access avoids `any`.
const TIMEZONES: string[] = (() => {
  const sv = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const all = sv ? sv("timeZone") : [];
  return all.length
    ? all
    : [
        "UTC", "Asia/Beirut", "Asia/Dubai", "Asia/Riyadh", "Asia/Amman", "Asia/Baghdad",
        "Africa/Cairo", "Europe/Istanbul", "Europe/London", "Europe/Paris", "Europe/Berlin",
        "America/New_York", "America/Chicago", "America/Los_Angeles",
      ];
})();
const TIMEZONE_OPTS: Array<[string, string]> = TIMEZONES.map((t) => [t, t]);

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
      const { id: _id, configVersion: _cv, createdAt: _c, updatedAt: _u, workspaceId: _t, ...editable } =
        form as Record<string, unknown>;
      const res = await apiFetch("/api/workspace/ai-assistant", {
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
            <Field label="Timezone"><SelectInput value={str("timezone") || "Asia/Beirut"} onChange={(v) => set("timezone", v)} options={TIMEZONE_OPTS} /></Field>
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
            <Field label="Supported languages (pick up to 12 — the assistant is told it speaks these)" full>
              <MultiSelect
                value={Array.isArray(form.supportedLanguages) ? (form.supportedLanguages as string[]) : []}
                options={LANGUAGES}
                max={12}
                onChange={(v) => set("supportedLanguages", v)}
              />
            </Field>
            <Field label="Default language"><SelectInput value={str("defaultLanguage") || "ar"} onChange={(v) => set("defaultLanguage", v)} options={LANGUAGES} /></Field>
            <Field label="Language policy">
              <SelectInput value={str("languagePolicy") || "match_customer"} onChange={(v) => set("languagePolicy", v)} options={[["match_customer", "Match customer"], ["default_language", "Always default"], ["specific", "Specific language"]]} />
            </Field>
            {str("languagePolicy") === "specific" && (
              <Field label="Specific language"><SelectInput value={str("specificLanguage") || "ar"} onChange={(v) => set("specificLanguage", v)} options={LANGUAGES} /></Field>
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
            <Field label="Tone"><SelectInput value={str("tone") || "friendly"} onChange={(v) => set("tone", v)} options={TONES} /></Field>
            <Field label="Reply length">
              <SelectInput value={str("replyLength") || "balanced"} onChange={(v) => set("replyLength", v)} options={[["short", "Short"], ["balanced", "Balanced"], ["detailed", "Detailed"]]} />
            </Field>
            <Field label="Auto-reply mode">
              <SelectInput value={str("autoReplyMode") || "auto_send"} onChange={(v) => set("autoReplyMode", v)} options={[["auto_send", "Auto-send"], ["draft", "Draft for approval"], ["hybrid", "Hybrid (draft in-hours, auto after-hours)"]]} />
            </Field>
            <Field label="Confidence threshold (0–1)"><NumberInput value={num("confidenceThreshold", 0.55)} step={0.05} min={0} max={1} onChange={(v) => set("confidenceThreshold", v)} /></Field>
            <Field label="Max auto-replies per conversation (0 = unlimited)"><NumberInput value={num("maxAutoRepliesPerConv", 0)} step={1} min={0} onChange={(v) => set("maxAutoRepliesPerConv", v)} /></Field>
            <Field label="Wait for customer to finish (seconds, 0 = reply instantly)"><NumberInput value={num("replyWaitSeconds", 0)} step={1} min={0} max={120} onChange={(v) => set("replyWaitSeconds", v)} /></Field>
            <Field label="Human takeover behavior"><SelectInput value={str("humanTakeoverBehavior") || "cancel_and_yield"} onChange={(v) => set("humanTakeoverBehavior", v)} options={TAKEOVER} /></Field>
            <SwitchRow label="Match customer tone" checked={bool("matchCustomerTone")} onChange={(v) => set("matchCustomerTone", v)} />
            <SwitchRow label="Ask new customers for their email (once)" checked={bool("collectCustomerEmail")} onChange={(v) => set("collectCustomerEmail", v)} />
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
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SelectInput value={str("voiceId") || "alloy"} onChange={(v) => set("voiceId", v)} options={OPENAI_VOICES} />
                </div>
                <VoicePreviewButton
                  voiceId={str("voiceId") || "alloy"}
                  voiceLanguage={str("voiceLanguage") || "ar"}
                  voiceSpeed={num("voiceSpeed", 1)}
                />
              </div>
            </Field>
            <Field label="Voice language"><SelectInput value={str("voiceLanguage") || "ar"} onChange={(v) => set("voiceLanguage", v)} options={LANGUAGES} /></Field>
            <Field label="Voice speed"><SelectInput value={String(num("voiceSpeed", 1))} onChange={(v) => set("voiceSpeed", Number(v))} options={VOICE_SPEEDS} /></Field>
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
    // The <label> WRAPS the control now. It used to sit beside it with no
    // `htmlFor`, so it looked like a label and was one visually, but nothing
    // associated the two — every field here announced as an unnamed text box.
    // Wrapping gives implicit association without needing to thread ids through
    // every call site, and the inner <span> preserves the original layout.
    <label className={full ? "col-span-2 block" : "col-span-2 block sm:col-span-1"}>
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
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
function VoicePreviewButton({
  voiceId,
  voiceLanguage,
  voiceSpeed,
}: {
  voiceId: string;
  voiceLanguage: string;
  voiceSpeed: number;
}) {
  const [loading, setLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  async function preview() {
    setLoading(true);
    try {
      const res = await apiFetch("/api/workspace/ai-assistant/voice-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voiceId, voiceLanguage, voiceSpeed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        toast.error(data.detail || data.error || "Voice preview failed");
        return;
      }
      const blob = await res.blob();
      // Stop + free any previous clip before playing the new one.
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      await audio.play();
    } catch {
      toast.error("Voice preview failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant="secondary" size="sm" disabled={loading} onClick={() => void preview()}>
      {loading ? "…" : "▶ Preview"}
    </Button>
  );
}
function MultiSelect({
  value,
  options,
  onChange,
  max,
}: {
  value: string[];
  options: Array<[string, string]>;
  onChange: (v: string[]) => void;
  max?: number;
}) {
  const selected = new Set(value);
  const atMax = max != null && value.length >= max;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([v, label]) => {
        const on = selected.has(v);
        const disabled = !on && atMax;
        return (
          <button
            key={v}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== v) : [...value, v])}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              on
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
          >
            {label}
          </button>
        );
      })}
    </div>
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
    // Keep the row as soon as EITHER end is set so partial entry (pick open,
    // then close) isn't discarded mid-edit. A day counts as closed only when
    // both ends are empty.
    if (range.open || range.close) next[day] = [range];
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
            {/* The day name is a sibling <span>, so each time field needs its
                own name — otherwise a screen reader hears fourteen identical
                unnamed time inputs with no way to tell Monday from Sunday. */}
            <Input
              type="time"
              aria-label={`${label} — opening time`}
              value={r.open}
              onChange={(e) => setDay(key, { ...r, open: e.target.value })}
            />
            <span className="text-muted-foreground">–</span>
            <Input
              type="time"
              aria-label={`${label} — closing time`}
              value={r.close}
              onChange={(e) => setDay(key, { ...r, close: e.target.value })}
            />
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
    const res = await apiFetch("/api/workspace/ai-assistant/documents");
    if (!res.ok) return;
    const data = (await res.json()) as { documents?: AiDocument[] };
    if (data.documents) setDocuments(data.documents);
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiFetch("/api/workspace/ai-assistant/documents", { method: "POST", body: fd });
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
    const res = await apiFetch(`/api/workspace/ai-assistant/documents/${doc.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !doc.enabled }),
    });
    if (res.ok) await refresh();
  }
  async function reprocess(doc: AiDocument) {
    const res = await apiFetch(`/api/workspace/ai-assistant/documents/${doc.id}/reprocess`, { method: "POST" });
    if (res.ok) {
      toast.success("Reprocessing…");
      await refresh();
    }
  }
  async function remove(doc: AiDocument) {
    const res = await apiFetch(`/api/workspace/ai-assistant/documents/${doc.id}`, { method: "DELETE" });
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
