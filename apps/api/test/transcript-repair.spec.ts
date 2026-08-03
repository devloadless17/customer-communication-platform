/**
 * Dialect repair guard — the rule that a "repair" which strayed is discarded.
 *
 * Claude genuinely fixes Lebanese that the speech model rendered as near-miss
 * MSA (measured on a real call: "كفيه سادك" → "كيف فيني ساعدك", the Egyptian
 * "دلوقتي" → "هلق", "ديش" → "ليش"). But the SAME run also rewrote the
 * unintelligible "الشلام" as "المعلومة" — a plausible invention presented as
 * fact, which is the failure this pipeline has fought at every layer.
 *
 * So the repair is bounded rather than trusted: it must keep most of the
 * original words and roughly the original length, or the RAW text is stored.
 * These tests pin the guard, not the model — the network call is stubbed so
 * the thresholds are asserted deterministically.
 *
 *   pnpm --filter @ccp/api exec vitest run test/transcript-repair.spec.ts
 */
import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

import * as anthropic from "@/lib/ai/anthropic-client";
import { repairLebaneseTranscript } from "@/lib/ai/transcript-repair";

const RAW =
  "ألو. أهلاً. صباح الخير. صباح النور، تفضل كفيه سادك؟ ديش عم أدقلك؟ " +
  "هيك عم أحاول إجازك الصباح باكي. طيب، إذا بدك شي حكيني. يالله، كرام.";

function stubClaude(corrected: string) {
  vi.spyOn(anthropic, "anthropicConfigured").mockReturnValue(true);
  vi.spyOn(anthropic, "chatJsonAnthropic").mockResolvedValue({
    data: { corrected },
  } as never);
}

afterEach(() => vi.restoreAllMocks());

describe("repairLebaneseTranscript", () => {
  it("accepts a genuine dialect repair", async () => {
    // The real measured corrections: Egyptian → Lebanese, near-miss → real word.
    const corrected = RAW.replace("كفيه سادك", "كيف فيني ساعدك")
      .replace("ديش", "ليش")
      .replace("الصباح باكي", "الصبح باكير")
      .replace("كرام", "كرمال");
    stubClaude(corrected);
    await expect(
      repairLebaneseTranscript({ text: RAW, language: "arabic" }),
    ).resolves.toBe(corrected);
  });

  it("REJECTS a rewrite that dropped most of the original words", async () => {
    // A model that "cleans up" by paraphrasing has invented a conversation.
    stubClaude("مرحبا كيف حالك اليوم بدي اسأل عن الطلب تبعي شكرا الك كتير");
    await expect(
      repairLebaneseTranscript({ text: RAW, language: "arabic" }),
    ).resolves.toBeNull();
  });

  it("REJECTS a repair that added content", async () => {
    stubClaude(
      RAW +
        " شكراً لاتصالك فينا، رح نبعتلك التفاصيل عالواتساب وبكون معك خلال ساعة، " +
        "وإذا بدك شي تاني لا تتردد تحكينا بأي وقت.",
    );
    await expect(
      repairLebaneseTranscript({ text: RAW, language: "arabic" }),
    ).resolves.toBeNull();
  });

  it("REJECTS a repair that swallowed content", async () => {
    stubClaude("ألو. أهلاً. صباح الخير.");
    await expect(
      repairLebaneseTranscript({ text: RAW, language: "arabic" }),
    ).resolves.toBeNull();
  });

  it("returns null when nothing changed — no pointless write", async () => {
    stubClaude(RAW);
    await expect(
      repairLebaneseTranscript({ text: RAW, language: "arabic" }),
    ).resolves.toBeNull();
  });

  it("does not touch a NON-Arabic transcript", async () => {
    const spy = vi.spyOn(anthropic, "chatJsonAnthropic");
    vi.spyOn(anthropic, "anthropicConfigured").mockReturnValue(true);
    await expect(
      repairLebaneseTranscript({
        text: "Hello, thanks for calling, how can I help you today please?",
        language: "english",
      }),
    ).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips a fragment too short to repair from context", async () => {
    const spy = vi.spyOn(anthropic, "chatJsonAnthropic");
    vi.spyOn(anthropic, "anthropicConfigured").mockReturnValue(true);
    await expect(
      repairLebaneseTranscript({ text: "ألو", language: "arabic" }),
    ).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the raw transcript when Claude errors — never throws", async () => {
    vi.spyOn(anthropic, "anthropicConfigured").mockReturnValue(true);
    vi.spyOn(anthropic, "chatJsonAnthropic").mockRejectedValue(new Error("upstream 529"));
    await expect(
      repairLebaneseTranscript({ text: RAW, language: "arabic" }),
    ).resolves.toBeNull();
  });

  it("is inert without an Anthropic key", async () => {
    vi.spyOn(anthropic, "anthropicConfigured").mockReturnValue(false);
    const spy = vi.spyOn(anthropic, "chatJsonAnthropic");
    await expect(
      repairLebaneseTranscript({ text: RAW, language: "arabic" }),
    ).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
