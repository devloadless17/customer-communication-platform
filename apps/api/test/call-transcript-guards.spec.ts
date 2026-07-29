/**
 * Call-transcript quality guards — the filters that decide whether a
 * transcription is trustworthy enough to store.
 *
 * Three live failures drove these, in order:
 *   1. a customer channel carrying real Lebanese Arabic stored as Cyrillic
 *      gibberish ("самоһам булакиһанц") — a language the workspace does not
 *      speak, accepted because nothing validated the detection;
 *   2. a 50-second Lebanese Arabic call stored as the English sentence "I want
 *      to ask you something." repeated some twenty-five times — a REPETITION
 *      LOOP, invisible to per-segment `compression_ratio` because each segment
 *      held one clean unrepeated sentence;
 *   3. both reached the database through an UNGUARDED fallback that ran a
 *      different model with no quality signals at all.
 *
 * The rule these encode: no transcript is a better answer than a confident
 * wrong one. An agent reading a stored transcript has no way to tell an
 * invented sentence from a real one.
 *
 *   pnpm --filter @ccp/api exec vitest run test/call-transcript-guards.spec.ts
 */
import { describe, expect, it } from "vitest";

import {
  __testing__,
} from "@/lib/media/call-recording-download";

const { looksLikeRepetitionLoop, isPlausibleLanguage, languagePolicyFrom, isSubstantive } =
  __testing__;

describe("looksLikeRepetitionLoop", () => {
  it("catches the exact transcript that shipped to a customer", () => {
    // Reproduced from the reported screenshot.
    const looped = Array.from(
      { length: 25 },
      () => "I want to ask you something.",
    ).join(" ");
    const text = `Hello, how are you? Are you okay? I want to ask you something. ${looped}`;
    expect(looksLikeRepetitionLoop(text)).toBe(true);
  });

  it("catches a loop with NO sentence punctuation to split on", () => {
    // The second detector: vocabulary collapse. Whisper loops sometimes arrive
    // as an unpunctuated run, which the sentence-frequency check can't see.
    const text = Array.from({ length: 60 }, () => "شو بدك").join(" ");
    expect(looksLikeRepetitionLoop(text)).toBe(true);
  });

  it("does NOT flag a real conversation that repeats a phrase naturally", () => {
    // A person genuinely saying "yes" or a greeting twice must survive — the
    // failure mode being fixed is DROPPED words, so a false positive here
    // silently deletes a real transcript.
    const text =
      "مرحبا، كيف حالك؟ اي اي، منيح الحمدلله. بدي استفسر عن حالة طلبي الاخير من فضلك. " +
      "اي اكيد، بس خليني اشوف الطلب. طيب شكرا كتير الك. اي، عفوا.";
    expect(looksLikeRepetitionLoop(text)).toBe(false);
  });

  it("does not flag ordinary English support dialogue", () => {
    const text =
      "Hello, thanks for calling. How can I help you today? " +
      "I wanted to check on my order please. Sure, can I take the order number? " +
      "Yes, it is four four two one. Thank you, let me look that up for you.";
    expect(looksLikeRepetitionLoop(text)).toBe(false);
  });

  it("is silent on short text — too little evidence to judge", () => {
    expect(looksLikeRepetitionLoop("Hello? Hello? Hello?")).toBe(false);
  });
});

describe("language plausibility (validate, never force)", () => {
  // Mirrors the reported workspace: AI Assistant → Languages & Dialect with
  // Arabic + English selected and Arabic as the default.
  const policy = languagePolicyFrom({
    supportedLanguages: ["ar", "en"],
    defaultLanguage: "ar",
    languagePolicy: "match_customer",
    specificLanguage: null,
  });

  it("rejects the language behind the Cyrillic gibberish", () => {
    expect(isPlausibleLanguage("bashkir", policy)).toBe(false);
    expect(isPlausibleLanguage("russian", policy)).toBe(false);
  });

  it("accepts BOTH languages the workspace declared — never forces Arabic", () => {
    // Code-switching is on and English is supported, so a genuine English call
    // must pass untouched. Pinning Arabic across the board would mistranslate it.
    expect(isPlausibleLanguage("arabic", policy)).toBe(true);
    expect(isPlausibleLanguage("english", policy)).toBe(true);
  });

  it("accepts anything when the workspace declared nothing", () => {
    // Never invent a restriction the operator didn't configure.
    const none = languagePolicyFrom({ supportedLanguages: null, defaultLanguage: null });
    expect(isPlausibleLanguage("bashkir", none)).toBe(true);
  });

  it("resolves the retry language from the workspace default", () => {
    expect(policy.fallback).toBe("ar");
    const specific = languagePolicyFrom({
      supportedLanguages: ["ar", "en"],
      defaultLanguage: "ar",
      languagePolicy: "specific",
      specificLanguage: "en",
    });
    expect(specific.fallback).toBe("en");
  });
});

describe("isSubstantive", () => {
  it("rejects the punctuation-only output a model emits for silence", () => {
    // Measured: whisper-1 answered line noise with " ." twice.
    expect(isSubstantive(" . ")).toBe(false);
    expect(isSubstantive("...")).toBe(false);
    expect(isSubstantive("   ")).toBe(false);
  });

  it("keeps real words in any script", () => {
    expect(isSubstantive("مرحبا")).toBe(true);
    expect(isSubstantive("hello")).toBe(true);
    expect(isSubstantive("4421")).toBe(true);
  });
});
