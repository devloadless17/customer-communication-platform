"use client";

import type { ComponentType } from "react";
import { MessageSquare, Phone } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { useNotificationSounds } from "@/providers/notification-sound-provider";
import type { SoundCategory } from "@/lib/notifications/notification-sound";

/**
 * Notification-sound toggles rendered in the AppRail user menu, directly under
 * the AvailabilityPicker. Two independent per-device switches (New messages,
 * Calls). Enabling one plays a short preview — instant audible confirmation and
 * (since the click is a user gesture) it also unlocks browser autoplay.
 *
 * Plain <button>s (not DropdownMenuItem) so a click toggles in place without
 * closing the menu — same pattern AvailabilityPicker uses.
 */

const ROWS: { key: SoundCategory; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { key: "messages", label: "New messages", icon: MessageSquare },
  { key: "calls", label: "Calls", icon: Phone },
];

export function NotificationSoundPicker() {
  const { prefs, setPref, preview } = useNotificationSounds();

  return (
    <div className="flex flex-col px-1 py-1">
      <div className="px-2 pb-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
        Notification sounds
      </div>
      <div className="flex flex-col gap-0.5">
        {ROWS.map(({ key, label, icon: Icon }) => {
          const enabled = prefs[key];
          return (
            <button
              key={key}
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={`${label} sound`}
              onClick={() => {
                const next = !enabled;
                setPref(key, next);
                if (next) preview(key);
              }}
              className={cn(
                "group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none transition-colors",
                "text-foreground/80 hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/60",
              )}
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 font-medium">{label}</span>
              <ToggleTrack on={enabled} />
            </button>
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
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors duration-200",
        on ? "bg-emerald-600" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "inline-block size-3.5 rounded-full bg-white shadow-sm transition-transform duration-200",
          on ? "translate-x-[13px]" : "translate-x-[2px]",
        )}
      />
    </span>
  );
}
