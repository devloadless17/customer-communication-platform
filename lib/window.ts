/**
 * 24-hour customer service window logic.
 *
 * From CLAUDE.md: WhatsApp Cloud API only allows free-form outbound to
 * contacts that messaged us within the last 24 hours. Outside the window,
 * only pre-approved templates can be sent. This helper turns "last inbound
 * timestamp" into a UI-friendly status.
 *
 * Pure (no DB / no time mocking) so client and server can both compute it
 * from a serialized timestamp. The current time is `now` so callers can
 * pass `Date.now()` from a `useEffect` ticker if they want the badge to
 * update as the window approaches close.
 */

export const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;
/** Below this remaining time we flag "closing soon" so agents can wrap up. */
export const WINDOW_CLOSING_SOON_MS = 4 * 60 * 60 * 1000;

export type WindowState = "never" | "closed" | "closing-soon" | "open";

export interface WindowStatus {
  state: WindowState;
  /** ISO timestamp of the last inbound, or null if there's never been one. */
  lastInboundAt: string | null;
  /** When the window will (or did) close — null if no inbound exists. */
  expiresAt: string | null;
  /** Milliseconds until close. Negative when closed. Null when no inbound. */
  msUntilClose: number | null;
}

export function computeWindowStatus(
  lastInboundAt: string | null,
  now: number = Date.now(),
): WindowStatus {
  if (!lastInboundAt) {
    return { state: "never", lastInboundAt: null, expiresAt: null, msUntilClose: null };
  }
  const lastMs = new Date(lastInboundAt).getTime();
  if (Number.isNaN(lastMs)) {
    return { state: "never", lastInboundAt: null, expiresAt: null, msUntilClose: null };
  }
  const expires = lastMs + WINDOW_DURATION_MS;
  const msUntilClose = expires - now;
  let state: WindowState;
  if (msUntilClose <= 0) state = "closed";
  else if (msUntilClose <= WINDOW_CLOSING_SOON_MS) state = "closing-soon";
  else state = "open";
  return {
    state,
    lastInboundAt,
    expiresAt: new Date(expires).toISOString(),
    msUntilClose,
  };
}

/**
 * "8h left" / "32m left" / "closed 3d ago". Compact label for a status
 * chip; pair with `windowStateLabel` for the lead-in word.
 */
export function formatWindowRemaining(status: WindowStatus): string {
  if (status.state === "never") return "no inbound yet";
  const ms = status.msUntilClose ?? 0;
  if (ms <= 0) {
    return `closed ${humanizeDuration(-ms)} ago`;
  }
  return `${humanizeDuration(ms)} left`;
}

export function windowStateLabel(state: WindowState): string {
  switch (state) {
    case "open":
      return "In window";
    case "closing-soon":
      return "Closing soon";
    case "closed":
      return "Window closed";
    case "never":
      return "No window";
  }
}

function humanizeDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
