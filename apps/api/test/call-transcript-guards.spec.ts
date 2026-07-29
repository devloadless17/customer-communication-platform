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

const { looksLikeRepetitionLoop, isPlausibleLanguage, languagePolicyFrom, isSubstantive, pickBestRendering } =
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

describe("pickBestRendering — speaker labels never cost words", () => {
  const seg = (speaker: "Business" | "Customer", text: string, start = 0) => ({
    id: 0, speaker, start, text,
  });

  it("uses the MIX when the isolated legs lost most of the conversation", () => {
    // The echo case the maintainer identified: two devices in one room, so both
    // legs carry the same voice and the browser's echo canceller mangles the
    // microphone leg. The split then yields fragments ("I don't...just...just")
    // while the mix — what a human hears on playback — is perfectly clear.
    const split = {
      text: "Agent: I don't...just...just...",
      segments: [seg("Business", "I don't...just...just...")],
    };
    const mixed = {
      text: "Hello, test test. Yes I can hear you fine, go ahead please.",
      segments: [],
    };
    expect(pickBestRendering(split, mixed, "c1")).toBe(mixed);
  });

  it("keeps the SPEAKER-ATTRIBUTED rendering when the split held the words", () => {
    // Independent legs (a customer on a distant phone). Here the mix is the
    // lossy one — measured, it can drop an entire speaker — so attribution wins.
    const split = {
      text: "Agent: Hello, how can I help?\nCustomer: I want to ask about my order please.",
      segments: [
        seg("Business", "Hello, how can I help?"),
        seg("Customer", "I want to ask about my order please.", 3),
      ],
    };
    const mixed = {
      text: "Hello, how can I help? I want to ask about my order please.",
      segments: [],
    };
    expect(pickBestRendering(split, mixed, "c2")).toBe(split);
  });

  it("does not surrender attribution over a couple of filler words", () => {
    // Two decodes never agree exactly; a 15% slack keeps the labels.
    const split = {
      text: "Agent: Hello how can I help you today",
      segments: [seg("Business", "Hello how can I help you today")],
    };
    const mixed = { text: "Um, hello, how can I help you today, uh", segments: [] };
    expect(pickBestRendering(split, mixed, "c3")).toBe(split);
  });

  it("returns whichever rendering exists when only one does", () => {
    const only = { text: "Hello", segments: [] };
    expect(pickBestRendering(null, only, "c4")).toBe(only);
    expect(pickBestRendering(only, null, "c5")).toBe(only);
    expect(pickBestRendering(null, null, "c6")).toBeNull();
  });

  it("ignores the speaker prefixes when comparing — they are not content", () => {
    // "Agent: " / "Customer: " inflate the split's text length. Comparing raw
    // strings would hand it a free win over an equally good mix.
    const split = { text: "Agent: hi\nCustomer: ok", segments: [seg("Business", "hi"), seg("Customer", "ok", 1)] };
    const mixed = { text: "hi ok and quite a lot more was actually said here", segments: [] };
    expect(pickBestRendering(split, mixed, "c7")).toBe(mixed);
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
