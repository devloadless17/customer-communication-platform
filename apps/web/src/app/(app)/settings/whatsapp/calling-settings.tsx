"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Phone,
  PhoneOff,
  X,
} from "lucide-react";

import { RECORDING_ANNOUNCEMENT_LANGUAGES } from "@ccp/shared/providers/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

/**
 * WhatsApp Calling configuration.
 *
 * Two things worth understanding about this screen:
 *
 * 1. It reads through to Meta on every load rather than trusting a local
 *    cache. An admin can change these in WhatsApp Manager directly, so a
 *    cached view drifts and then lies.
 * 2. "Available 24/7" is NOT a 00:00-23:59 window. Call hours are
 *    minute-granular, so that shape refuses calls for the last minute of every
 *    day; Meta's own way to say "always open" is to disable call hours
 *    entirely, which is what an empty window list means here.
 */

const DAYS = [
  { key: "MONDAY", label: "Monday" },
  { key: "TUESDAY", label: "Tuesday" },
  { key: "WEDNESDAY", label: "Wednesday" },
  { key: "THURSDAY", label: "Thursday" },
  { key: "FRIDAY", label: "Friday" },
  { key: "SATURDAY", label: "Saturday" },
  { key: "SUNDAY", label: "Sunday" },
] as const;

type DayKey = (typeof DAYS)[number]["key"];

interface CallHoursWindow {
  dayOfWeek: DayKey;
  openTime: string;
  closeTime: string;
}

type VoicemailTrigger = "REJECT" | "TIMEOUT";

interface CallSettingsState {
  enabled: boolean;
  callIconVisible: boolean;
  callbackPermissionEnabled: boolean;
  hours: { timezoneId: string; windows: CallHoursWindow[] } | null;
  callIconCountries: string[];
  voicemail: {
    enabled: boolean;
    triggers: string[];
    announcementMediaId: string | null;
    timeoutSeconds: number | null;
  } | null;
  restrictions: Array<{
    type: string;
    reason: string;
    expiresAt: string | null;
  }>;
}

interface ReadinessCheck {
  key: string;
  ok: boolean;
  label: string;
  detail: string | null;
}

interface RecordingPolicy {
  enabled: boolean;
  purpose?: string;
  announcementLanguage?: string;
}

interface Readiness {
  ready: boolean;
  checks: ReadinessCheck[];
  settings: CallSettingsState | null;
  recordingPolicy: RecordingPolicy | null;
  transcriptionPolicy: RecordingPolicy | null;
  consentMessage: string | null;
  artifactMode: "meta" | "inapp";
}

/** "HHMM" → "HH:MM" for an <input type="time">, and back. */
const toTimeInput = (hhmm: string) => `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
const fromTimeInput = (value: string) => value.replace(":", "");

export function CallingSettings({
  displayNumber,
  canManage,
  accountId,
}: {
  displayNumber: string | null;
  canManage: boolean;
  /** The connection being configured. Calling settings live on the phone
   *  number, so a multi-number workspace must say WHICH number — omitted
   *  keeps the single-account default resolution. */
  accountId?: string | null;
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Draft hours, edited locally and committed on Save. Kept separate from
  // `readiness` so a half-edited schedule isn't written on every keystroke.
  const [hoursMode, setHoursMode] = useState<"always" | "custom">("always");
  const [timezoneId, setTimezoneId] = useState("UTC");
  const [windows, setWindows] = useState<CallHoursWindow[]>([]);
  // Draft call-icon country restriction, edited as free text ("US, BR") and
  // parsed on Save — same draft-then-commit shape as the hours editor.
  const [iconCountries, setIconCountries] = useState("");
  // Draft voicemail config. Committed by its own Save: enabling needs an
  // uploaded announcement first, so it can't be an instant toggle-patch.
  const [vmEnabled, setVmEnabled] = useState(false);
  const [vmTriggers, setVmTriggers] = useState<VoicemailTrigger[]>(["TIMEOUT"]);
  const [vmTimeout, setVmTimeout] = useState(20);
  const [vmMediaId, setVmMediaId] = useState<string | null>(null);
  const [vmUploading, setVmUploading] = useState(false);
  // Draft recording/transcription policies — draft-then-Save like
  // hours/voicemail, because enabling makes every future call open with a
  // consent announcement.
  const [recEnabled, setRecEnabled] = useState(false);
  const [recPurpose, setRecPurpose] = useState("");
  const [recLanguage, setRecLanguage] = useState("en");
  const [trEnabled, setTrEnabled] = useState(false);
  const [trPurpose, setTrPurpose] = useState("");
  const [trLanguage, setTrLanguage] = useState("en");
  // The written consent notice — ours end-to-end, so fully Arabic-capable.
  const [consentMessage, setConsentMessage] = useState("");
  // How artifacts are produced: WhatsApp built-in vs in-app (browser records).
  const [artifactMode, setArtifactMode] = useState<"meta" | "inapp">("meta");

  // Same account-qualification the sibling panels use: explicit account when
  // the picker chose one, the legacy no-param request otherwise.
  const accountQuery = accountId
    ? `?accountId=${encodeURIComponent(accountId)}`
    : "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/calls/admin/readiness${accountQuery}`);
      if (!res.ok) {
        // A team that hasn't connected WhatsApp yet lands here; the connection
        // card above already tells them what to do, so stay quiet.
        setReadiness(null);
        return;
      }
      const data = (await res.json()) as Readiness;
      setReadiness(data);
      const hours = data.settings?.hours ?? null;
      setHoursMode(hours ? "custom" : "always");
      setTimezoneId(
        hours?.timezoneId ??
          Intl.DateTimeFormat().resolvedOptions().timeZone ??
          "UTC",
      );
      setWindows(hours?.windows ?? []);
      setIconCountries((data.settings?.callIconCountries ?? []).join(", "));
      const vm = data.settings?.voicemail ?? null;
      setVmEnabled(vm?.enabled ?? false);
      const knownTriggers = (vm?.triggers ?? []).filter(
        (t): t is VoicemailTrigger => t === "REJECT" || t === "TIMEOUT",
      );
      setVmTriggers(knownTriggers.length ? knownTriggers : ["TIMEOUT"]);
      setVmTimeout(vm?.timeoutSeconds ?? 20);
      setVmMediaId(vm?.announcementMediaId ?? null);
      const rec = data.recordingPolicy;
      setRecEnabled(rec?.enabled ?? false);
      setRecPurpose(rec?.purpose ?? "");
      setRecLanguage(rec?.announcementLanguage ?? "en");
      const tr = data.transcriptionPolicy;
      setTrEnabled(tr?.enabled ?? false);
      setTrPurpose(tr?.purpose ?? "");
      setTrLanguage(tr?.announcementLanguage ?? "en");
      setConsentMessage(data.consentMessage ?? "");
      setArtifactMode(data.artifactMode ?? "meta");
    } catch {
      setReadiness(null);
    } finally {
      setLoading(false);
    }
  }, [accountQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await apiFetch(`/api/calls/admin/settings${accountQuery}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(err.detail ?? "Couldn't save your calling settings.");
        return;
      }
      const settings = (await res.json()) as CallSettingsState;
      setReadiness((prev) => (prev ? { ...prev, settings } : prev));
      toast.success("Calling settings saved.");
      // Meta takes time to propagate these to customers' clients, and an admin
      // who doesn't know that will think the save didn't work.
      toast.message?.(
        "WhatsApp can take up to 7 days to show this change to every customer.",
      );
    } finally {
      setSaving(false);
    }
  }

  function saveIconCountries() {
    const codes = iconCountries
      .split(/[,\s]+/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    const invalid = codes.filter((c) => !/^[A-Z]{2}$/.test(c));
    if (invalid.length) {
      toast.error(
        `Use two-letter country codes (like US or BR) — not: ${invalid.join(", ")}`,
      );
      return;
    }
    // An empty list is a real value: it CLEARS the restriction.
    void patch({ callIconCountries: codes });
  }

  async function uploadAnnouncement(file: File) {
    setVmUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // No content-type header: the browser must set the multipart boundary.
      const res = await apiFetch(
        `/api/calls/admin/voicemail-announcement${accountQuery}`,
        { method: "POST", body: fd },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(
          err.detail ??
            "Couldn't upload the announcement. It must be an OGG (OPUS) audio file under 60 seconds.",
        );
        return;
      }
      const { mediaId } = (await res.json()) as { mediaId: string };
      setVmMediaId(mediaId);
      toast.success("Announcement uploaded — save voicemail to apply it.");
    } finally {
      setVmUploading(false);
    }
  }

  function saveVoicemail() {
    if (!vmEnabled) {
      void patch({ voicemail: { enabled: false } });
      return;
    }
    if (!vmTriggers.length) {
      toast.error("Pick at least one trigger for voicemail.");
      return;
    }
    if (!vmMediaId) {
      toast.error("Upload an announcement recording first.");
      return;
    }
    void patch({
      voicemail: {
        enabled: true,
        triggers: vmTriggers,
        announcementMediaId: vmMediaId,
        ...(vmTriggers.includes("TIMEOUT")
          ? { timeoutSeconds: vmTimeout }
          : {}),
      },
    });
  }

  async function saveArtifactMode(mode: "meta" | "inapp") {
    setSaving(true);
    try {
      const res = await apiFetch(
        `/api/calls/admin/artifact-mode${accountQuery}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(err.detail ?? "Couldn't change the recording method.");
        return;
      }
      setArtifactMode(mode);
      toast.success(
        mode === "inapp"
          ? "In-app method active — calls record silently in the agent's browser, no announcement."
          : "WhatsApp built-in method active — calls open with the spoken consent announcement.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveArtifactPolicy(
    path: "recording-policy" | "transcription-policy",
    draft: { enabled: boolean; purpose: string; language: string },
    onMessage: string,
    offMessage: string,
  ) {
    // In-app mode plays no announcement, so the purpose is optional there.
    if (artifactMode === "meta" && draft.enabled && !draft.purpose.trim()) {
      toast.error("Write the purpose — it's spoken to both parties.");
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`/api/calls/admin/${path}${accountQuery}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          draft.enabled
            ? {
                enabled: true,
                ...(draft.purpose.trim()
                  ? { purpose: draft.purpose.trim() }
                  : {}),
                announcementLanguage: draft.language,
                mode: artifactMode,
              }
            : { enabled: false },
        ),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(err.detail ?? "Couldn't save the policy.");
        return;
      }
      toast.success(draft.enabled ? onMessage : offMessage);
    } finally {
      setSaving(false);
    }
  }

  async function saveConsentMessage() {
    setSaving(true);
    try {
      const res = await apiFetch(
        `/api/calls/admin/consent-message${accountQuery}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: consentMessage.trim() || null }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { detail?: string };
        toast.error(err.detail ?? "Couldn't save the consent message.");
        return;
      }
      toast.success(
        consentMessage.trim()
          ? "Consent message saved — it will be sent around recorded calls."
          : "Consent message cleared.",
      );
    } finally {
      setSaving(false);
    }
  }

  const settings = readiness?.settings;

  if (loading) {
    return (
      <section className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading calling settings…
      </section>
    );
  }
  if (!readiness) return null;

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-semibold">Calling</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Voice calls with customers, on the same number you message from.
        </p>
      </div>

      <ReadinessList checks={readiness.checks} />

      {settings && canManage && (
        <div className="flex flex-col gap-4 rounded-lg border p-4">
          <ToggleRow
            label="Calling enabled"
            hint="Customers can call you, and your agents can call them."
            checked={settings.enabled}
            disabled={saving}
            onChange={(enabled) => void patch({ enabled })}
          />
          <ToggleRow
            label="Show the call button to customers"
            hint="Turn this off to keep calling available to your agents while hiding it from your WhatsApp profile. This is WhatsApp's recommended fix if your number gets flagged for a low call pickup rate."
            checked={settings.callIconVisible}
            disabled={saving || !settings.enabled}
            onChange={(callIconVisible) => void patch({ callIconVisible })}
          />
          {settings.callIconVisible && (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">
                Only show the call button in certain countries
              </p>
              <p className="text-xs text-muted-foreground">
                Two-letter country codes, comma-separated (like “US, BR”).
                WhatsApp matches on the customer’s phone number country, not
                where they are right now. Leave empty to show it everywhere.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={iconCountries}
                  onChange={(e) => setIconCountries(e.target.value)}
                  placeholder="Everywhere"
                  disabled={saving || !settings.enabled}
                  className="max-w-xs"
                  aria-label="Call button countries"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={saving || !settings.enabled}
                  onClick={saveIconCountries}
                >
                  Save
                </Button>
              </div>
            </div>
          )}
          <ToggleRow
            label="Allow callbacks automatically"
            hint="When a customer calls you, they automatically allow you to call them back. Worth leaving on — it's permission you get without having to ask for it."
            checked={settings.callbackPermissionEnabled}
            disabled={saving || !settings.enabled}
            onChange={(callbackPermissionEnabled) =>
              void patch({ callbackPermissionEnabled })
            }
          />

          <div className="border-t pt-4">
            <CallHoursEditor
              mode={hoursMode}
              timezoneId={timezoneId}
              windows={windows}
              disabled={saving || !settings.enabled}
              onModeChange={setHoursMode}
              onTimezoneChange={setTimezoneId}
              onWindowsChange={setWindows}
              onSave={() =>
                void patch({
                  hours:
                    hoursMode === "always"
                      ? { timezoneId, windows: [] }
                      : { timezoneId, windows },
                })
              }
            />
          </div>

          <div className="border-t pt-4">
            <VoicemailEditor
              enabled={vmEnabled}
              triggers={vmTriggers}
              timeoutSeconds={vmTimeout}
              hasAnnouncement={vmMediaId !== null}
              uploading={vmUploading}
              disabled={saving || !settings.enabled}
              hoursRestricted={hoursMode === "custom"}
              onEnabledChange={setVmEnabled}
              onTriggersChange={setVmTriggers}
              onTimeoutChange={setVmTimeout}
              onUpload={(file) => void uploadAnnouncement(file)}
              onSave={saveVoicemail}
            />
          </div>

          <div className="border-t pt-4">
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">Recording method</p>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">In-app</span> records silently in
                the agent&apos;s browser — no spoken announcement, recordings
                appear instantly, and transcripts come from your own AI with
                native Arabic. Your written consent message below becomes the
                notice your customers see.{" "}
                <span className="font-medium">WhatsApp built-in</span> opens
                every call with WhatsApp&apos;s spoken consent announcement
                (English/French voices only) and delivers artifacts about a
                minute after the call.
              </p>
              <Select
                value={artifactMode}
                onChange={(e) =>
                  void saveArtifactMode(e.target.value as "meta" | "inapp")
                }
                disabled={saving}
                className="max-w-xs"
                aria-label="Recording method"
              >
                <option value="inapp">
                  In-app — silent, Arabic-first (recommended)
                </option>
                <option value="meta">
                  WhatsApp built-in — spoken announcement
                </option>
              </Select>
            </div>
          </div>

          <div className="border-t pt-4">
            <ArtifactPolicyEditor
              mode={artifactMode}
              title="Record calls"
              description="Every placed and answered call on this number is recorded. WhatsApp first speaks a legally required consent announcement to BOTH parties — recording starts only after it finishes, and a customer can hang up to decline. The finished audio appears on the Calls page about a minute after the call ends."
              warning="WhatsApp's announcement voice does not support Arabic yet — for Arabic-speaking customers the closest options are English or French. The purpose text below is spoken as-is by that same voice; if you write it in Arabic, place a test call first to hear how it renders. For a fully-Arabic consent experience, send an Arabic message telling the customer the call will be recorded before you dial."
              purposeLabel="Recording purpose"
              saveLabel="Save recording"
              enabled={recEnabled}
              purpose={recPurpose}
              language={recLanguage}
              disabled={saving || !settings.enabled}
              onEnabledChange={setRecEnabled}
              onPurposeChange={setRecPurpose}
              onLanguageChange={setRecLanguage}
              onSave={() =>
                void saveArtifactPolicy(
                  "recording-policy",
                  { enabled: recEnabled, purpose: recPurpose, language: recLanguage },
                  "Call recording is on — every new call starts with the consent announcement.",
                  "Call recording turned off.",
                )
              }
            />
          </div>

          <div className="border-t pt-4">
            <ArtifactPolicyEditor
              mode={artifactMode}
              title="Transcribe calls"
              description="Every placed and answered call on this number is transcribed into text — WhatsApp auto-detects the spoken language, and Arabic is fully supported, so Arabic calls produce Arabic transcripts. The same consent announcement rule applies (one combined announcement when recording is also on, using the recording settings). Transcripts appear on the Calls page about a minute after the call ends."
              warning="Only the short spoken announcement lacks Arabic — the transcript itself will be in Arabic automatically. If recording is also enabled, WhatsApp uses the RECORDING purpose and language for the combined announcement and ignores these."
              purposeLabel="Transcription purpose"
              saveLabel="Save transcription"
              enabled={trEnabled}
              purpose={trPurpose}
              language={trLanguage}
              disabled={saving || !settings.enabled}
              onEnabledChange={setTrEnabled}
              onPurposeChange={setTrPurpose}
              onLanguageChange={setTrLanguage}
              onSave={() =>
                void saveArtifactPolicy(
                  "transcription-policy",
                  { enabled: trEnabled, purpose: trPurpose, language: trLanguage },
                  "Call transcription is on — Arabic calls will produce Arabic transcripts.",
                  "Call transcription turned off.",
                )
              }
            />
          </div>

          {(recEnabled || trEnabled) && (
            <div className="border-t pt-4">
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">
                  Written consent message — Arabic ready
                </p>
                <p className="text-xs text-muted-foreground">
                  Sent automatically into the chat around recorded or
                  transcribed calls: before dialing on outbound, and the moment
                  an agent answers on inbound. Unlike WhatsApp&apos;s spoken
                  announcement, this message is yours — write it in Arabic and
                  your customers get clear written notice in their own
                  language, kept in the conversation as proof.
                </p>
                <textarea
                  value={consentMessage}
                  maxLength={1000}
                  rows={3}
                  dir="auto"
                  onChange={(e) => setConsentMessage(e.target.value)}
                  placeholder="سيتم تسجيل هذه المكالمة لأغراض الجودة وتحسين الخدمة."
                  disabled={saving}
                  className="max-w-md rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Written consent message"
                />
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => void saveConsentMessage()}
                  >
                    Save message
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {settings && !canManage && (
        <p className="text-xs text-muted-foreground">
          Only admins can change calling settings.
        </p>
      )}

      <CallDeepLink displayNumber={displayNumber} />
    </section>
  );
}

/**
 * The setup checklist. Each failing row names a real prerequisite that would
 * otherwise produce a confusing failure — the worst being a missing `calls`
 * webhook subscription, where calls place fine and then ring into a void with
 * nothing in the logs to explain it.
 */
function ReadinessList({ checks }: { checks: ReadinessCheck[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {checks.map((check) => (
        <li key={check.key} className="flex items-start gap-2 text-sm">
          {check.ok ? (
            <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          ) : (
            <X className="mt-0.5 size-4 shrink-0 text-destructive" />
          )}
          <div className="min-w-0">
            <span className={check.ok ? "" : "font-medium"}>{check.label}</span>
            {check.detail && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {check.detail}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

/**
 * Shared editor for the two per-number call-artifact policies (recording and
 * transcription): identical provider request shape, identical consent rules,
 * different copy. Draft-then-Save — enabling changes what every future call
 * opens with.
 */
function ArtifactPolicyEditor({
  mode,
  title,
  description,
  warning,
  purposeLabel,
  saveLabel,
  enabled,
  purpose,
  language,
  disabled,
  onEnabledChange,
  onPurposeChange,
  onLanguageChange,
  onSave,
}: {
  /** "meta" shows the announcement fields; "inapp" plays no announcement so
   *  they're hidden and the copy explains the silent flow. */
  mode: "meta" | "inapp";
  title: string;
  description: string;
  warning: string;
  purposeLabel: string;
  saveLabel: string;
  enabled: boolean;
  purpose: string;
  language: string;
  disabled?: boolean;
  onEnabledChange: (next: boolean) => void;
  onPurposeChange: (next: string) => void;
  onLanguageChange: (next: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onEnabledChange}
          aria-label={title}
        />
      </div>
      {enabled && mode === "inapp" && (
        <p className="text-xs text-muted-foreground">
          In-app method: no announcement plays. The call records silently in
          the answering agent&apos;s browser and is stored the moment the call
          ends — make sure your written consent message below says what your
          customers need to hear, in Arabic.
        </p>
      )}
      {enabled && mode === "meta" && (
        <>
          <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {warning}
          </p>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">Announcement language</p>
            <Select
              value={language}
              onChange={(e) => onLanguageChange(e.target.value)}
              disabled={disabled}
              className="max-w-xs"
              aria-label={`${title} announcement language`}
            >
              {RECORDING_ANNOUNCEMENT_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">{purposeLabel}</p>
            <p className="text-xs text-muted-foreground">
              Spoken to both parties right after the announcement phrase, e.g.
              “quality assurance”. Up to 250 characters — write it in the
              announcement language above.
            </p>
            <Input
              value={purpose}
              maxLength={250}
              onChange={(e) => onPurposeChange(e.target.value)}
              placeholder="quality assurance"
              disabled={disabled}
              className="max-w-md"
              aria-label={purposeLabel}
            />
          </div>
        </>
      )}
      <div>
        <Button type="button" size="sm" disabled={disabled} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Voicemail configuration. Draft-then-Save like the hours editor — enabling
 * needs an uploaded announcement first, so it can't be an instant
 * toggle-patch. The announcement upload happens immediately (it's just a
 * staging upload with no customer-visible effect until Save pins it).
 */
function VoicemailEditor({
  enabled,
  triggers,
  timeoutSeconds,
  hasAnnouncement,
  uploading,
  disabled,
  hoursRestricted,
  onEnabledChange,
  onTriggersChange,
  onTimeoutChange,
  onUpload,
  onSave,
}: {
  enabled: boolean;
  triggers: VoicemailTrigger[];
  timeoutSeconds: number;
  hasAnnouncement: boolean;
  uploading: boolean;
  disabled?: boolean;
  hoursRestricted: boolean;
  onEnabledChange: (next: boolean) => void;
  onTriggersChange: (next: VoicemailTrigger[]) => void;
  onTimeoutChange: (next: number) => void;
  onUpload: (file: File) => void;
  onSave: () => void;
}) {
  function setTrigger(trigger: VoicemailTrigger, on: boolean) {
    const rest = triggers.filter((t) => t !== trigger);
    onTriggersChange(on ? [...rest, trigger] : rest);
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Voicemail</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            When a customer’s call goes unanswered, WhatsApp answers, plays
            your announcement, records their message, and delivers it to the
            inbox as a voice note.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onEnabledChange}
          aria-label="Voicemail"
        />
      </div>
      {enabled && (
        <>
          {hoursRestricted && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              You also have call hours set. Customers can’t place calls outside
              those hours, so after-hours calls never reach voicemail — WhatsApp
              recommends 24/7 availability when voicemail is on.
            </p>
          )}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Record a voicemail when…</p>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={triggers.includes("TIMEOUT")}
                disabled={disabled}
                onCheckedChange={(on) => setTrigger("TIMEOUT", on)}
                aria-label="Record when nobody answers in time"
              />
              <span className="flex items-center gap-2">
                Nobody answers within
                <Input
                  type="number"
                  min={0}
                  max={30}
                  value={timeoutSeconds}
                  disabled={disabled || !triggers.includes("TIMEOUT")}
                  onChange={(e) =>
                    onTimeoutChange(
                      Math.max(0, Math.min(30, Number(e.target.value) || 0)),
                    )
                  }
                  className="w-16"
                  aria-label="Seconds of ringing before voicemail"
                />
                seconds
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={triggers.includes("REJECT")}
                disabled={disabled}
                onCheckedChange={(on) => setTrigger("REJECT", on)}
                aria-label="Record when an agent declines the call"
              />
              An agent declines the call
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">Announcement</p>
            <p className="text-xs text-muted-foreground">
              An OGG (OPUS) audio file under 60 seconds, played to the caller
              before recording starts. This is YOUR recording — record it in
              Arabic for Arabic-speaking customers.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept="audio/ogg,.ogg,.opus"
                disabled={disabled || uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Reset so re-picking the same file re-fires onChange.
                  e.target.value = "";
                  if (file) onUpload(file);
                }}
                className="text-xs file:mr-2 file:rounded-md file:border file:bg-transparent file:px-2 file:py-1 file:text-xs"
                aria-label="Upload voicemail announcement"
              />
              {uploading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : hasAnnouncement ? (
                <span className="flex items-center gap-1 text-xs text-emerald-600">
                  <Check className="size-3.5" /> Uploaded
                </span>
              ) : null}
            </div>
          </div>
        </>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          disabled={disabled || uploading}
          onClick={onSave}
        >
          Save voicemail
        </Button>
      </div>
    </div>
  );
}

function CallHoursEditor({
  mode,
  timezoneId,
  windows,
  disabled,
  onModeChange,
  onTimezoneChange,
  onWindowsChange,
  onSave,
}: {
  mode: "always" | "custom";
  timezoneId: string;
  windows: CallHoursWindow[];
  disabled?: boolean;
  onModeChange: (m: "always" | "custom") => void;
  onTimezoneChange: (tz: string) => void;
  onWindowsChange: (w: CallHoursWindow[]) => void;
  onSave: () => void;
}) {
  function setDay(day: DayKey, open: boolean) {
    onWindowsChange(
      open
        ? [...windows, { dayOfWeek: day, openTime: "0900", closeTime: "1700" }]
        : windows.filter((w) => w.dayOfWeek !== day),
    );
  }
  function setTime(day: DayKey, field: "openTime" | "closeTime", value: string) {
    onWindowsChange(
      windows.map((w) =>
        w.dayOfWeek === day ? { ...w, [field]: fromTimeInput(value) } : w,
      ),
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">When customers can call you</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Outside these hours WhatsApp tells the customer you&apos;re closed and
          offers them a callback instead of letting the call ring unanswered.
        </p>
      </div>

      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={mode === "always"}
            disabled={disabled}
            onChange={() => onModeChange("always")}
          />
          Any time
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            checked={mode === "custom"}
            disabled={disabled}
            onChange={() => onModeChange("custom")}
          />
          Set hours
        </label>
      </div>

      {mode === "custom" && (
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Timezone</span>
            <Select
              value={timezoneId}
              disabled={disabled}
              onChange={(e) => onTimezoneChange(e.target.value)}
              className="max-w-xs"
            >
              {/* The browser's own zone first — it's almost always the answer,
                  and hunting for it in a 400-entry list is a chore. */}
              {Array.from(
                new Set([
                  Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
                  "UTC",
                  ...(typeof Intl.supportedValuesOf === "function"
                    ? Intl.supportedValuesOf("timeZone")
                    : []),
                ]),
              ).map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </label>

          {DAYS.map((day) => {
            const win = windows.find((w) => w.dayOfWeek === day.key);
            return (
              <div key={day.key} className="flex items-center gap-3 text-sm">
                <label className="flex w-32 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(win)}
                    disabled={disabled}
                    onChange={(e) => setDay(day.key, e.target.checked)}
                  />
                  {day.label}
                </label>
                {win ? (
                  <>
                    <Input
                      type="time"
                      value={toTimeInput(win.openTime)}
                      disabled={disabled}
                      onChange={(e) =>
                        setTime(day.key, "openTime", e.target.value)
                      }
                      className="w-32"
                      aria-label={`${day.label} opening time`}
                    />
                    <span className="text-muted-foreground">to</span>
                    <Input
                      type="time"
                      value={toTimeInput(win.closeTime)}
                      disabled={disabled}
                      onChange={(e) =>
                        setTime(day.key, "closeTime", e.target.value)
                      }
                      className="w-32"
                      aria-label={`${day.label} closing time`}
                    />
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">Closed</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div>
        <Button type="button" size="sm" disabled={disabled} onClick={onSave}>
          {disabled ? <Loader2 className="size-4 animate-spin" /> : null}
          Save hours
        </Button>
      </div>
    </div>
  );
}

/**
 * A `wa.me/call/<number>` link opens a WhatsApp call straight to this business.
 * Put it on a website, in an email signature, or behind a QR code and customers
 * can call without saving the number first.
 *
 * Not supported on WhatsApp desktop clients — worth saying, because the first
 * thing anyone does is test it on their laptop.
 */
function CallDeepLink({ displayNumber }: { displayNumber: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!displayNumber) return null;
  const digits = displayNumber.replace(/\D/g, "");
  if (!digits) return null;
  const link = `https://wa.me/call/${digits}`;

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Phone className="size-4 text-muted-foreground" />
        <p className="text-sm font-medium">Your call link</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Share this anywhere and customers can start a WhatsApp call with you in
        one tap. Doesn&apos;t work on WhatsApp for desktop.
      </p>
      <div className="flex items-center gap-2">
        <Input readOnly value={link} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2_000);
            });
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Banner for an active calling restriction, rendered above the inbox rather
 * than only here — a paused number fails every call, and the agent hitting
 * that is not usually the admin who'd open Settings.
 */
export function CallingRestrictionBanner({
  reason,
  expiresAt,
}: {
  reason: string | null;
  expiresAt: string | null;
}) {
  if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div>
        <p className="font-medium">WhatsApp has paused calling on your number</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {reason ?? "Calls and call-permission requests will fail until this lifts."}
        </p>
      </div>
      <PhoneOff className="ml-auto size-4 shrink-0 text-muted-foreground" />
    </div>
  );
}
