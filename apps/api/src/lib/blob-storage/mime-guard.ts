import { kindFromMime, normalizeMimeType } from "@/lib/media-storage";

/**
 * Provider-agnostic media validation, shared by every blob-storage impl.
 *
 * Two gates, applied on EVERY upload:
 *   1. `assertAllowedMime` — the caller-claimed Content-Type must be in the
 *      per-kind allowlist. `kind` is set from Meta's categorization (or the
 *      route's own classification), NOT the sender's claim, so it's trustworthy.
 *   2. `assertSignatureMatches` — magic-byte sniff of the actual bytes, to close
 *      the "trust the client Content-Type" loophole (SVG-with-<script> labeled
 *      image/png → stored XSS when served same-origin via /api/media/<id>).
 *
 * Kept intact through the R2 migration so the defense is byte-for-byte the same
 * (security audit 2026-05-29 P0). Every blob provider imports these — the checks
 * live with the interface, not any one vendor.
 */

/**
 * Mime allowlist per kind. WhatsApp's documented mime set for each kind is the
 * source of truth; anything outside is refused. Critical defense: without this,
 * a malicious sender can stash an SVG-with-script in storage, served same-origin
 * via /api/media/<id> → stored XSS. The Meta webhook trusts content-type from
 * the sender's claim.
 */
export const ALLOWED_MIME_BY_KIND: Record<string, ReadonlySet<string>> = {
  image: new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    // NOTE: SVG intentionally excluded. SVG can embed <script> and would
    // be a stored XSS vector when rendered same-origin via /api/media/<id>.
  ]),
  video: new Set([
    "video/mp4",
    "video/3gpp",
    "video/quicktime",
    // webm is what a desktop screen recording and MediaRecorder produce, and the
    // website widget renders it natively. This set is the STORAGE guard (its job
    // is blocking scriptable types like SVG — webm is benign raster), so it is the
    // wrong place to encode WhatsApp's mp4-only rule: that lives per channel in
    // `policy.videoMime`, which already lists webm for the permissive channels.
    // Without it a visitor's screen recording failed with a bare "Upload failed."
    "video/webm",
  ]),
  audio: new Set([
    "audio/aac",
    "audio/mp4",
    "audio/x-m4a", // m4a alt mime (some OS/browser file pickers)
    "audio/mpeg",
    "audio/amr",
    "audio/ogg",
    "audio/wav", // Messenger/Instagram accept wav; keep storage in step
    "audio/x-wav",
    "audio/webm",
    "audio/opus",
  ]),
  document: new Set([
    "application/pdf",
    "application/vnd.ms-powerpoint",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
  ]),
  // Stickers are webp on WhatsApp, but Messenger/Instagram deliver them as png /
  // gif / jpeg — all benign raster (SVG stays excluded, so no stored-XSS
  // surface). Without these, an inbound social sticker failed the download and
  // rendered "Attachment unavailable".
  sticker: new Set(["image/webp", "image/png", "image/gif", "image/jpeg"]),
};

export function assertAllowedMime(kind: string, mimeType: string): void {
  const allowed = ALLOWED_MIME_BY_KIND[kind];
  if (!allowed) return; // unknown kind — caller already enforces
  // Normalize via the one canonical parser (strip ;charset=…, trim, lowercase).
  const normalized = normalizeMimeType(mimeType);
  if (!allowed.has(normalized)) {
    throw new Error(
      `blob-storage: mime type "${normalized}" not allowed for kind "${kind}"`,
    );
  }
}

/**
 * Sniff the first ~12 bytes against a small magic-byte table and return the
 * inferred mime, or null if the signature isn't recognized. The allowlist above
 * is keyed on the CLIENT-CLAIMED Content-Type — without a sniff, an attacker can
 * upload `<svg onload="…">` bytes labeled `image/png` and bypass the SVG
 * exclusion.
 *
 * Tiny self-contained table — avoids the file-type dep (which loads a larger
 * detection corpus). Covers every kind in ALLOWED_MIME_BY_KIND that has a
 * meaningful binary signature. Text formats (text/plain, text/csv) are not
 * sniffable and skipped — the allowlist's claimed type is the only gate there.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const b = bytes;
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38 (GIF8)
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "image/gif";
  }
  // WEBP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50 (RIFF....WEBP)
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  // PDF: 25 50 44 46 (%PDF)
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return "application/pdf";
  }
  // MP4 / 3GP / MOV / M4A — `ftyp` box at offset 4: ?? ?? ?? ?? 66 74 79 70.
  // The major brand at bytes 8..11 disambiguates audio-only ISO-BMFF
  // containers (M4A = "M4A ", audiobook M4B = "M4B ") from video. The bare
  // container signature cannot tell audio from video, so known audio brands
  // are reported as audio/mp4 and everything else falls back to the video
  // canonical (see the mp4-family reconciliation in assertSignatureMatches
  // for generic-brand aac/m4a that still sniffs as video/mp4).
  if (
    b.length >= 12 &&
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  ) {
    // "M4A " / "M4B " => 4D 34 41/42 20
    if (b[8] === 0x4d && b[9] === 0x34 && (b[10] === 0x41 || b[10] === 0x42) && b[11] === 0x20) {
      return "audio/mp4";
    }
    return "video/mp4"; // canonical for the ftyp family
  }
  // OGG: 4F 67 67 53 (OggS)
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) {
    return "audio/ogg";
  }
  return null;
}

/**
 * Magic-byte families that mean "the same kind" for our allowlist purposes.
 * E.g. video/mp4 sniffs as video/mp4 but the caller may have claimed video/3gpp
 * — both are mp4-family ftyp boxes and both are legitimately allowed for the
 * video kind. Reject only when the sniffed and claimed kinds diverge beyond
 * same-family.
 */
export function kindOfMime(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

/**
 * An ISO Base Media (ftyp) container carries EITHER audio or video, and the
 * container bytes alone cannot always distinguish them — only some major brands
 * do (handled in sniffMime). So an ftyp sniff (video/mp4 or audio/mp4) is
 * compatible with ANY mp4-family audio OR video claim. Generic-brand aac/m4a
 * (e.g. iOS/Safari/Chrome recordings, shared audio files) sniff as video/mp4 yet
 * are legitimately claimed audio/mp4 or audio/aac.
 *
 * This is safe: the `kind` allowlist (set from Meta's categorization, not the
 * sniff) still gates audio-vs-video, and an mp4 container is never an HTML/SVG
 * XSS vector regardless of its audio/video label. Without this reconciliation a
 * whole class of inbound audio was rejected and silently dropped to text.
 */
const MP4_FAMILY: ReadonlySet<string> = new Set([
  "video/mp4",
  "video/quicktime",
  "video/3gpp",
  "audio/mp4",
  "audio/aac",
]);

/**
 * Reconcile a fetched Content-Type against the TRUSTED media kind for an
 * INBOUND download. `kind` comes from Meta's attachment categorization (the
 * webhook `type` / `messages[].type`), NOT the CDN's Content-Type, so it is
 * authoritative here.
 *
 * Meta's lookaside CDN routinely serves a voice note — an m4a/aac clip, which is
 * an MP4 container — with `Content-Type: video/mp4`. Storing that verbatim made
 * the `audio` allowlist reject a legitimate voice message: the download failed,
 * the row's media columns were stripped, and the bubble rendered "Attachment
 * unavailable" for EVERY inbound Messenger / Instagram voice note. Audio and
 * video carry no stored-XSS surface (bytes served with an `audio/*` or `video/*`
 * Content-Type can't execute script), so for those two kinds we can safely
 * coerce the stored mime to match the known kind.
 *
 * Image / sticker are repaired ONLY from the byte SNIFF, which can return just
 * png / jpeg / gif / webp — never SVG — so the stored-XSS surface stays closed.
 * Documents are returned UNCHANGED (they can legitimately be html/text): the
 * strict assertAllowedMime + sniff gate must decide there.
 */
export function reconcileInboundMediaMime(
  kind: string,
  fetchedMime: string,
  bytes: Uint8Array,
): string {
  const claimed = normalizeMimeType(fetchedMime);
  // Already consistent with the trusted kind — keep the CDN's type.
  if (kindFromMime(claimed) === kind) return claimed;
  // Documents keep the strict path (they may be html/text — XSS-sensitive).
  if (kind === "document") return claimed;
  // Trust the bytes: if the signature is a type of the right kind, use it. For a
  // sticker, Meta may serve png/gif whose sniffed kind is "image" — accept those
  // (the sticker allowlist covers png/gif/webp). This is the XSS-safe repair for
  // image/sticker (sniffMime never yields SVG).
  const sniffed = sniffMime(bytes);
  if (sniffed && (kindOfMime(sniffed) === kind || (kind === "sticker" && kindOfMime(sniffed) === "image"))) {
    return sniffed;
  }
  // Beyond this point only audio/video get a container/canonical fallback (no
  // XSS surface); image/sticker with an unrecognized sniff keep the strict gate.
  if (kind !== "audio" && kind !== "video") return claimed;
  // The common voice-note case: an mp4-family container mislabeled across the
  // audio/video line (audio kind, `video/mp4` claim, or the inverse). Coerce to
  // that kind's mp4 canonical — the allowlist accepts it and the signature check
  // reconciles it via MP4_FAMILY.
  if (MP4_FAMILY.has(claimed) || (sniffed && MP4_FAMILY.has(sniffed))) {
    return kind === "audio" ? "audio/mp4" : "video/mp4";
  }
  // Opaque/garbage Content-Type on trusted audio/video (e.g. octet-stream) →
  // canonical fallback for the kind so a real clip is never dropped to text.
  return kind === "audio" ? "audio/mpeg" : "video/mp4";
}

export function assertSignatureMatches(bytes: Uint8Array, claimedMime: string): void {
  const sniffed = sniffMime(bytes);
  if (!sniffed) return; // unknown signature (or text format) — claimed-mime gate stands
  const claimed = normalizeMimeType(claimedMime);
  if (sniffed === claimed) return;
  // Same kind-family is acceptable (mp4 ftyp can be claimed as 3gpp/mov/mp4).
  if (kindOfMime(sniffed) === kindOfMime(claimed)) return;
  // mp4-family container: an ftyp sniff matches an mp4 audio OR video claim.
  if (MP4_FAMILY.has(sniffed) && MP4_FAMILY.has(claimed)) return;
  throw new Error(
    `blob-storage: file signature "${sniffed}" does not match claimed mime "${claimed}"`,
  );
}
