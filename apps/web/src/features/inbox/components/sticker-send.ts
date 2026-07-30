import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

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
        // Idempotency: a double-tap on the tile must not send two stickers.
        clientTempId: `sticker-${sticker.id}-${conversationId}`,
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
