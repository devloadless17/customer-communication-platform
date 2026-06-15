"use client";

import type { ComponentType } from "react";
import { MessageSquare, Phone } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/layouts/page-header";
import { useNotificationSounds } from "@/providers/notification-sound-provider";
import type { SoundCategory } from "@/lib/notifications/notification-sound";

/**
 * Notification-sound settings. Two per-device switches (New messages, Calls).
 * Toggling on plays a short preview — instant audible confirmation, and since
 * the click is a user gesture it also unlocks browser autoplay for that sound.
 * Reads/writes through NotificationSoundProvider (localStorage + cross-tab
 * sync), so the toggles stay in step with any other tab on this device.
 */
const ROWS: {
  key: SoundCategory;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  {
    key: "messages",
    label: "New messages",
    description: "Play a sound when a new customer message arrives.",
    icon: MessageSquare,
  },
  {
    key: "calls",
    label: "Calls",
    description: "Play a ringtone for incoming WhatsApp calls.",
    icon: Phone,
  },
];

export function NotificationsSettings() {
  const { prefs, setPref, preview, receiveCalls, setReceiveCalls } =
    useNotificationSounds();

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Settings for this device, saved per browser — each teammate sets their own, and they don't affect anyone else on the team."
        className="mb-6"
      />

      <SectionLabel>Sounds</SectionLabel>
      <div className="mb-7 max-w-xl divide-y divide-border overflow-hidden rounded-lg border border-border">
        {ROWS.map(({ key, label, description, icon: Icon }) => {
          const enabled = prefs[key];
          return (
            <div key={key} className="flex items-center gap-3 px-4 py-3.5">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
              </div>
              <Switch
                checked={enabled}
                aria-label={`${label} sound`}
                onCheckedChange={(next) => {
                  setPref(key, next);
                  if (next) preview(key);
                }}
              />
            </div>
          );
        })}
      </div>

      <SectionLabel>Incoming calls</SectionLabel>
      <div className="max-w-xl overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <Phone className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Receive calls on this device</div>
            <div className="text-xs text-muted-foreground">
              When off, incoming WhatsApp calls won&apos;t pop up or ring here at
              all — your teammates still get them. Turn it off on a machine where
              you don&apos;t take calls.
            </div>
          </div>
          <Switch
            checked={receiveCalls}
            aria-label="Receive calls on this device"
            onCheckedChange={setReceiveCalls}
          />
        </div>
      </div>
      {!receiveCalls && (
        <p className="mt-2 max-w-xl text-xs text-amber-600 dark:text-amber-400">
          You won&apos;t be notified of incoming calls on this device.
        </p>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 px-0.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground/70">
      {children}
    </div>
  );
}

