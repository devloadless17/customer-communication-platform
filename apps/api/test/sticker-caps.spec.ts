import { describe, expect, it } from "vitest";

import { isAnimatedWebp } from "@/lib/media-storage";
import {
  WHATSAPP_STATIC_STICKER_MAX_BYTES,
  mediaSizeCap,
} from "@ccp/shared/providers/media-caps";

/**
 * WhatsApp splits the sticker size cap by kind — animated 500 KB, static
 * 100 KB (sticker-messages doc). The mime is image/webp either way, so the
 * discriminator is the webp container header: a VP8X first chunk whose flags
 * byte has the Animation bit (0x02). These specs pin the sniffer and the two
 * ceilings the send-path gate is built on.
 */

/** Build a minimal RIFF/WEBP header with the given first chunk + flags. */
function webpBytes(chunk: "VP8X" | "VP8 " | "VP8L", flags = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  const put = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  // riff size (unchecked by the sniffer)
  put(8, "WEBP");
  put(12, chunk);
  bytes[16] = 10; // chunk size (unchecked)
  bytes[20] = flags;
  return bytes;
}

describe("isAnimatedWebp", () => {
  it("detects the VP8X Animation flag (bit 0x02)", () => {
    expect(isAnimatedWebp(webpBytes("VP8X", 0x02))).toBe(true);
    expect(isAnimatedWebp(webpBytes("VP8X", 0x12))).toBe(true); // anim + alpha
  });

  it("treats VP8X without the flag, and simple VP8/VP8L, as static", () => {
    expect(isAnimatedWebp(webpBytes("VP8X", 0x10))).toBe(false); // alpha only
    expect(isAnimatedWebp(webpBytes("VP8 "))).toBe(false);
    expect(isAnimatedWebp(webpBytes("VP8L"))).toBe(false);
  });

  it("returns false (→ conservative static cap) on junk and truncated input", () => {
    expect(isAnimatedWebp(new Uint8Array(0))).toBe(false);
    expect(isAnimatedWebp(new Uint8Array(8))).toBe(false);
    expect(isAnimatedWebp(new Uint8Array(64).fill(0x41))).toBe(false); // "AAAA…"
  });
});

describe("the two sticker ceilings", () => {
  it("coarse table carries the animated 500 KB; static is 100 KB", () => {
    expect(mediaSizeCap("whatsapp", "sticker")).toBe(500 * 1024);
    expect(WHATSAPP_STATIC_STICKER_MAX_BYTES).toBe(100 * 1024);
  });
});
