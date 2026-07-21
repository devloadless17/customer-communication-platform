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

interface CallSettingsState {
  enabled: boolean;
  callIconVisible: boolean;
  callbackPermissionEnabled: boolean;
  hours: { timezoneId: string; windows: CallHoursWindow[] } | null;
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

interface Readiness {
  ready: boolean;
  checks: ReadinessCheck[];
  settings: CallSettingsState | null;
}

/** "HHMM" → "HH:MM" for an <input type="time">, and back. */
const toTimeInput = (hhmm: string) => `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`;
const fromTimeInput = (value: string) => value.replace(":", "");

export function CallingSettings({
  displayNumber,
  canManage,
}: {
  displayNumber: string | null;
  canManage: boolean;
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Draft hours, edited locally and committed on Save. Kept separate from
  // `readiness` so a half-edited schedule isn't written on every keystroke.
  const [hoursMode, setHoursMode] = useState<"always" | "custom">("always");
  const [timezoneId, setTimezoneId] = useState("UTC");
  const [windows, setWindows] = useState<CallHoursWindow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/calls/admin/readiness");
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
    } catch {
      setReadiness(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await apiFetch("/api/calls/admin/settings", {
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
