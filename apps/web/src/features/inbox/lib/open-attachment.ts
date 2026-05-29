import { toast } from "@/lib/toast";

/**
 * Open an attachment URL in a new tab, but probe the server first so the
 * user never lands on the blob provider's branded 404 page when a file is
 * missing (deleted, never uploaded, or expired upstream).
 *
 * Two probe paths, depending on the URL shape:
 *
 *   - `/api/media/<id>` (customer messages): the route accepts `?probe=1`
 *     and short-circuits with `{ available: boolean }` instead of issuing
 *     the 302 redirect.
 *   - Raw provider URLs (team-chat messages, where the upstream URL is
 *     embedded directly in the row payload): go through the generic
 *     `/api/media/probe?url=` endpoint, which HEADs the upstream after
 *     validating the host against the active provider's allow-list.
 *
 * Either way the answer is "is this file actually fetchable right now",
 * and the client only opens a tab when the answer is yes. Probe failures
 * (network error, timeout) fall through to opening the tab — the upstream
 * 404 page is still better UX than a false-positive toast blocking a
 * working link.
 */
export async function openAttachment(url: string, filename?: string | null): Promise<void> {
  const probeUrl = buildProbeUrl(url);
  let available = true;
  try {
    const r = await fetch(probeUrl, { credentials: "same-origin" });
    if (r.ok) {
      const body = (await r.json()) as { available?: boolean };
      available = body.available === true;
    } else {
      available = false;
    }
  } catch {
    // Network error → fall through to the tab open. Lets transient
    // failures degrade to "user might see the upstream 404" rather than
    // a false-positive toast that blocks a working file.
    available = true;
  }

  if (!available) {
    toast.error("Attachment unavailable", {
      description: filename
        ? `"${filename}" is no longer available — it may have been removed.`
        : "This file is no longer available — it may have been removed.",
    });
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

function buildProbeUrl(url: string): string {
  if (url.startsWith("/api/media/")) {
    return url.includes("?") ? `${url}&probe=1` : `${url}?probe=1`;
  }
  return `/api/media/probe?url=${encodeURIComponent(url)}`;
}
