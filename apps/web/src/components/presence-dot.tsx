import { AVAILABILITY_DOT_CLASSES, AVAILABILITY_LABELS } from "@ccp/shared/presence";
import { cn } from "@ccp/shared/utils";
import type { UserAvailabilityStatus } from "@ccp/shared/types";

/**
 * The small online/availability dot painted over a teammate's avatar.
 *
 * Extracted because this same ring+dot markup was already hand-rolled in four
 * places (app-rail, inbox-sub-sidebar, assignment-dropdown, availability-picker)
 * and team chat adds two more consumers (the channel members dialog and the DM
 * list). Six copies of a rule like "offline must look identical to no-socket"
 * is how they drift.
 *
 * Deliberately NOT refactoring the four existing call sites in this pass —
 * they're stable and working; let them migrate opportunistically.
 *
 * Colors and labels come from `@ccp/shared/presence`, which is the single
 * source of truth shared with the server-side fanout filter.
 */
export function PresenceDot({
  online,
  availability,
  className,
}: {
  /** Whether the user has a live socket. Offline wins over any availability. */
  online: boolean;
  /** The user's self-selected availability. Ignored when `online` is false. */
  availability?: UserAvailabilityStatus | null;
  className?: string;
}) {
  // A user who picked "Appear offline" and a user with no socket must be
  // visually indistinguishable — that's the whole point of the setting.
  const status: UserAvailabilityStatus = online ? (availability ?? "available") : "offline";
  const label = online ? AVAILABILITY_LABELS[status] : "Offline";

  return (
    <span
      // `ring-background` punches the dot out of the avatar behind it so it
      // stays legible on any list-row background.
      className={cn(
        "size-2.5 rounded-full ring-2 ring-background",
        AVAILABILITY_DOT_CLASSES[status],
        className,
      )}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
