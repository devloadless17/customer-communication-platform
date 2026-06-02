"use client";

import type { ComponentType } from "react";
import { MessageSquare, Phone } from "lucide-react";

import { cn } from "@ccp/shared/utils";
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
  const { prefs, setPref, preview } = useNotificationSounds();

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Sounds for this device. These are saved per browser — each teammate
          sets their own, and they don&apos;t affect anyone else on the team.
        </p>
      </header>

      <div className="max-w-xl divide-y divide-border overflow-hidden rounded-lg border border-border">
        {ROWS.map(({ key, label, description, icon: Icon }) => {
          const enabled = prefs[key];
          return (
            <div key={key} className="flex items-center gap-3 px-4 py-3.5">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${label} sound`}
                onClick={() => {
                  const next = !enabled;
                  setPref(key, next);
                  if (next) preview(key);
                }}
                className="shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <ToggleTrack on={enabled} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToggleTrack({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200",
        on ? "bg-emerald-600" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-block size-[18px] rounded-full bg-white shadow-sm transition-transform duration-200",
          on ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </span>
  );
}
