import { toast } from "@/lib/toast";

/**
 * Open an attachment URL in a new tab, but probe the server first so the
 * user never lands on the blob provider's branded 404 page when a file is
 * missing (deleted, never uploaded, or expired upstream).
 *
 * Every media URL is now one of our own same-origin proxy routes
 * (`/api/media/<id>`, `/api/team-chat/channels/.../media`, …). Each accepts
 * `?probe=1` and short-circuits with `{ available: boolean }` (a cheap
 * server-side existence check) instead of streaming the bytes. The client
 * only opens a tab when the answer is yes. Probe failures (network error,
 * timeout) fall through to opening the tab — a plain 404 is still better UX
 * than a false-positive toast blocking a working link.
 */
export async function openAttachment(url: string, filename?: string | null): Promise<void> {
  // I-9: open the tab SYNCHRONOUSLY, inside the user-gesture call stack. Browsers
  // (Safari, strict Firefox) only permit window.open during a gesture; after the
  // awaited probe below the gesture context is gone and a deferred window.open is
  // popup-blocked (returns null) — the agent clicks an attachment and nothing
  // happens. So open a blank tab now and navigate (or close) it once the probe
  // resolves. The `noopener` flag would null the returned handle we need to
  // navigate later, so sever `opener` manually to keep reverse-tabnabbing safety.
  const tab = window.open("about:blank", "_blank");
  if (tab) {
    try {
      tab.opener = null;
    } catch {
      // opener is read-only in some browsers — best-effort.
    }
  }

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
    tab?.close();
    toast.error("Attachment unavailable", {
      description: filename
        ? `"${filename}" is no longer available — it may have been removed.`
        : "This file is no longer available — it may have been removed.",
    });
    return;
  }

  if (tab) {
    tab.location.href = url;
  } else {
    // The synchronous open was blocked anyway (very strict settings) — last-ditch
    // direct open with the full security flags.
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function buildProbeUrl(url: string): string {
  // All media URLs are our own same-origin proxy routes that accept ?probe=1.
  return url.includes("?") ? `${url}&probe=1` : `${url}?probe=1`;
}

/**
 * Download a file directly — no tab, no navigation. For file types the browser
 * can't render inline (Word / Excel / PowerPoint / zip / …), opening a tab just
 * leaves an empty `about:blank` behind while the download starts. Instead we
 * hit `?download=1` (the api responds `Content-Disposition: attachment` with the
 * real filename) via a transient same-origin anchor, so the browser downloads
 * in place. Use `openAttachment` for VIEWABLE types (PDF/images) instead.
 */
export function downloadAttachment(url: string): void {
  const dl = url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
  const a = document.createElement("a");
  a.href = dl;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
