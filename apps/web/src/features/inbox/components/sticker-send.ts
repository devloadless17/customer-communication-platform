import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

import { newClientTempId } from "./reply-box/utils";

/**
 * POST a sticker pick.
 *
 * Its OWN module, split out of `sticker-picker.tsx`, because the composer calls
 * it eagerly while the picker itself is `dynamic()`-loaded. Importing this from
 * the picker file would statically pull the whole component — a grid of remote
 * images and its loading state — into the main inbox bundle and quietly undo the
 * lazy import next to it.
 */
export async function sendSticker(
  conversationId: string,
  sticker: { id: string; imageUrl?: string },
): Promise<boolean> {
  try {
    const res = await apiFetch("/api/messages/sticker", {
      method: "POST",
      // apiFetch sets no content-type of its own.
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId,
        stickerId: sticker.id,
        ...(sticker.imageUrl ? { imageUrl: sticker.imageUrl } : {}),
        // Idempotency, per ATTEMPT — the same fresh-id-per-send the composer
        // mints. The server's lock keys on (workspace, user, conversation,
        // clientTempId) and caches a SUCCESS for 5 minutes, so a deterministic
        // id made "send that sticker again" within the window replay the first
        // result: no second sticker, no error, nothing on screen. Double-tap is
        // already blocked by the picker's `sending` gate; this id only has to
        // dedupe a re-POST of THIS attempt.
        clientTempId: newClientTempId(),
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { detail?: string; error?: string }
        | null;
      toast.error(body?.detail ?? body?.error ?? "Couldn't send the sticker.");
      return false;
    }
    return true;
  } catch {
    toast.error("Couldn't reach the server.");
    return false;
  }
}
