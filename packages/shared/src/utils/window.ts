/**
 * Free-form customer-service window logic.
 *
 * Some channels (WhatsApp Cloud API) only allow free-form outbound to
 * contacts that messaged us within a per-channel time window. Outside the
 * window, only pre-approved templates can be sent. This module turns
 * "last inbound timestamp" + "channel capability" into a UI-friendly status.
 *
 * Channel-specific durations live on each provider's `capabilities.freeFormWindowMs`
 * (lib/providers/types.ts). The constants below are the WhatsApp defaults
 * exported for backwards compat with existing inbox UI; new code should
 * read from provider capabilities.
 *
 * Pure (no DB / no time mocking) so client and server can both compute it.
 * `now` is parameterized so a ticker hook can re-derive on each second to
 * make the badge tick down without re-fetching.
 */

/** WhatsApp's 24h customer-service window — the default we still ship. */
export const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;
/** Below this remaining time we flag "closing soon" so agents can wrap up. */
export const WINDOW_CLOSING_SOON_MS = 4 * 60 * 60 * 1000;

export type WindowState = "never" | "closed" | "closing-soon" | "open";

/**
 * The widest window (ms) in which an agent may send free-form outbound on a
 * channel — the human-agent extension when the channel has one (Meta social:
 * 7 days), else the standard free-form window (WhatsApp: 24h). `null` means the
 * channel has no window restriction at all (e.g. Telegram), so no gate applies.
 *
 * This is the window the SEND gate uses ("can I send at all"). The narrower
 * `freeFormWindowMs` still decides whether the provider must attach a
 * support-policy tag (Meta Human Agent) for sends past the standard window.
 * Structural param so this stays in @ccp/shared/utils with no providers import.
 */
export function effectiveSendWindowMs(caps: {
  freeFormWindowMs: number | null;
  humanAgentWindowMs?: number | null;
}): number | null {
  if (caps.freeFormWindowMs === null) return null;
  return caps.humanAgentWindowMs ?? caps.freeFormWindowMs;
}

/**
 * Human-readable reason a free-form send is blocked, derived from the channel's
 * CAPABILITIES rather than assuming WhatsApp. Templated channels (WhatsApp) can
 * re-engage with an approved template; social channels (Messenger/Instagram)
 * have no template catalog and simply need the customer to message again — and
 * their reply window is 7 days, not 24h. Keeps every send path's copy accurate.
 */
export function closedWindowMessage(caps: {
  templates?: boolean;
  freeFormWindowMs: number | null;
  humanAgentWindowMs?: number | null;
}): string {
  if (caps.templates) {
    return "24h customer-service window closed — send an approved template to re-engage.";
  }
  const ms = effectiveSendWindowMs(caps);
  const days = ms ? Math.round(ms / (24 * 60 * 60 * 1000)) : 0;
  const within =
    days > 0 ? `within ${days} day${days === 1 ? "" : "s"} of` : "shortly after";
  return `Messaging window closed — you can only reply ${within} the customer's last message. Wait for them to message again to reopen the conversation.`;
}

/**
 * Meta social only: is a send OUTSIDE the free-form (24h) window — i.e. in the
 * 24h–7d support band where the Human Agent tag is required? Within 24h the send
 * uses `messaging_type: RESPONSE` (no tag). Returns false when the channel has no
 * window model (`freeFormMs` null), so a non-social channel never forces the tag.
 * Single source of truth for the tag decision across every send path (internal
 * UI text/media/interactive, workflow steps, and the /v1 API) — reuses
 * `computeWindowStatus` for boundary parity with the preflight window check.
 */
export function outsideFreeFormWindow(
  freeFormMs: number | null,
  lastInboundAt: string | null,
  now: number = Date.now(),
): boolean {
  if (freeFormMs === null) return false;
  const { state } = computeWindowStatus(lastInboundAt, now, freeFormMs);
  return state === "closed" || state === "never";
}

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
  windowMs: number = WINDOW_DURATION_MS,
): WindowStatus {
  if (!lastInboundAt) {
    return { state: "never", lastInboundAt: null, expiresAt: null, msUntilClose: null };
  }
  const lastMs = new Date(lastInboundAt).getTime();
  if (Number.isNaN(lastMs)) {
    return { state: "never", lastInboundAt: null, expiresAt: null, msUntilClose: null };
  }
  const expires = lastMs + windowMs;
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
