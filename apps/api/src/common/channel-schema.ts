import { z } from "zod";
import { isChannelLive } from "@ccp/shared/providers/capabilities";
import type { Channel } from "@ccp/shared/types";

/**
 * A Zod schema accepting exactly the channels in `LIVE_CHANNELS`, derived from
 * the single source of truth (`isChannelLive`). Use it for every request-level
 * channel filter instead of a hand-written `z.enum(["whatsapp", …])` — those
 * duplicated the live set at scattered sites and silently drifted when a channel
 * was added (a newly-live channel would 400 on the count/broadcast paths, or
 * fall back to all-channels on a `.catch(undefined)` list path). Behavior for a
 * currently-live channel is identical to the old enum; only the source of the
 * accepted set changes, so a shipped channel becomes usable everywhere at once.
 *
 * Compose the same modifiers the enum used (`.optional()`, `.catch(undefined)`).
 */
export function zLiveChannel() {
  return z.custom<Channel>(
    (v) => typeof v === "string" && isChannelLive(v as Channel),
    { message: "unsupported channel" },
  );
}
