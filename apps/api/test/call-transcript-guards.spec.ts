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

const {
  looksLikeRepetitionLoop,
  isPlausibleLanguage,
  languagePolicyFrom,
  isSubstantive,
  wordOverlap,
  looksLikePromptEcho,
} = __testing__;

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

describe("buildCallPrompt — dialect + proper-noun bias", () => {
  it("anchors Lebanese, and puts the anchor LAST so truncation can't eat it", () => {
    // Measured on phone-grade audio: without this anchor "هلق" comes back as
    // "حلّك" and "منيح" as "ميح" — near-miss MSA forms, which is exactly what
    // a reported live transcript looked like. The prompt window keeps the LAST
    // 224 tokens, so a long product list must not push the anchor off the front.
    const prompt = languagePolicyFrom({
      defaultLanguage: "ar",
      lebaneseDialect: true,
      companyName: "شركة الاختبار",
      products: "x".repeat(500),
      supportedLanguages: ["ar", "en"],
    }).prompt!;
    expect(prompt).toContain("هلق");
    expect(prompt).toContain("منيح");
    expect(prompt.indexOf("شركة الاختبار")).toBeLessThan(prompt.indexOf("هلق"));
  });

  it("SHOWS the Arabic/English mixing Lebanese speakers actually use", () => {
    // An Arabic-ONLY prompt makes the model transliterate English into Arabic
    // script — measured: "order" → "أوردر", "delivery" → "الدليفري", and
    // "price" → "البيت" ("the house"), a meaning error. Demonstrating the
    // mixing in the prompt kept all three in Latin script.
    const prompt = languagePolicyFrom({
      defaultLanguage: "ar",
      lebaneseDialect: true,
      codeSwitching: true,
      supportedLanguages: ["ar", "en"],
    }).prompt!;
    expect(prompt).toContain("order");
    expect(prompt).toContain("delivery");
    expect(prompt).toContain("please");
  });

  it("drops the English examples when code-switching is turned off", () => {
    const prompt = languagePolicyFrom({
      defaultLanguage: "ar",
      lebaneseDialect: true,
      codeSwitching: false,
      supportedLanguages: ["ar"],
    }).prompt!;
    expect(prompt).not.toContain("order");
    expect(prompt).toContain("هلق");
  });

  it("carries the business's own nouns — the words a model otherwise invents", () => {
    const prompt = languagePolicyFrom({
      defaultLanguage: "ar",
      lebaneseDialect: true,
      companyName: "مطعم الشام",
      supportedLanguages: ["ar"],
    }).prompt!;
    expect(prompt).toContain("مطعم الشام");
  });

  it("produces NO prompt for a non-Arabic workspace", () => {
    // A prompt in the wrong language biases against the audio.
    expect(
      languagePolicyFrom({ defaultLanguage: "en", supportedLanguages: ["en"] }).prompt,
    ).toBeNull();
  });

  it("drops the Lebanese wording when the dialect toggle is off", () => {
    const prompt = languagePolicyFrom({
      defaultLanguage: "ar",
      lebaneseDialect: false,
      supportedLanguages: ["ar"],
    }).prompt!;
    expect(prompt).not.toContain("هلق");
    expect(prompt).toContain("العربية");
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

describe("wordOverlap — the echo guard on speaker separation", () => {
  it("flags two legs that are really the same speech", () => {
    // Both devices in one room: each leg picks up BOTH voices, so the two
    // sides transcribe to nearly the same words. Presenting that as a dialogue
    // shows the agent and the customer each saying every line. The channels
    // are measurably DIFFERENT here, so only the text reveals it — the
    // identical-channel check cannot.
    const a = "ألو كيفك عم تسمعني منيح بدي استفسر عن الطلب تكرم عينك";
    const b = "ألو كيفك عم تسمعني منيح بدي استفسر عن الطلب تكرم عينك يالله";
    expect(wordOverlap(a, b)).toBeGreaterThan(0.7);
  });

  it("does NOT flag a real two-sided conversation", () => {
    // Genuine dialogue shares connectives and greetings but not content.
    const agent = "ألو كيفك أهلا وسهلا كيف فيني ساعدك اليوم";
    const customer = "بدي استفسر عن حالة طلبي الأخير والدفعة يلي بعتها";
    expect(wordOverlap(agent, customer)).toBeLessThan(0.7);
  });

  it("uses CONTAINMENT so a faint echo leg is still caught", () => {
    // The quieter leg yields fewer words. Jaccard would score this pair as
    // dissimilar precisely when it is the same speech; containment does not.
    const loud = "ألو كيفك عم تسمعني منيح بدي استفسر عن الطلب تكرم عينك يالله باي";
    const faint = "كيفك عم تسمعني منيح";
    expect(wordOverlap(loud, faint)).toBe(1);
  });

  it("is zero when either side is empty", () => {
    expect(wordOverlap("", "مرحبا كيفك")).toBe(0);
    expect(wordOverlap("مرحبا كيفك", "")).toBe(0);
  });
});

describe("looksLikePromptEcho — the model handing back its own prompt", () => {
  const prompt = languagePolicyFrom({
    defaultLanguage: "ar",
    lebaneseDialect: true,
    codeSwitching: true,
    supportedLanguages: ["ar", "en"],
  }).prompt!;

  it("catches a SILENT call that stored the whole prompt as its transcript", () => {
    // Production, verbatim: a 50-second call in which NOBODY SPOKE stored the
    // entire dialect prompt as the conversation. With no speech to transcribe
    // the model simply continued the text it was given — and the result reads
    // like a real call, which is what makes this the worst failure class here.
    const produced =
      "ألو، كيفك؟ يالله، هلق بشوفلك ياها. لحظة من فضلك، عم اسمعك منيح. تكرم عينك. " +
      "أوكي، بعتلك الـ order عالـ delivery. please خليني أعرف الـ price. thank you، يالله bye.";
    expect(looksLikePromptEcho(produced, prompt)).toBe(true);
  });

  it("catches the exact echo seen on a real 24-second call", () => {
    // gpt-4o-transcribe returned a verbatim slice of the dialect prompt as the
    // transcript of a conversation it never rendered. The worst failure in the
    // pipeline: it reads as an ordinary transcript, so nothing looks wrong.
    expect(looksLikePromptEcho("ألو، كيفك؟ يالله، هلق بشوفلك ياها.", prompt)).toBe(true);
  });

  it("does NOT flag real speech that happens to open the same way", () => {
    // "ألو" and "كيفك" are IN the prompt precisely because people say them —
    // a real call starting that way must survive, or the guard deletes the
    // very transcripts it exists to protect.
    const real =
      "ألو. أهلاً. صباح الخير. صباح النور، تفضل كيف فيني ساعدك؟ " +
      "بدي استفسر عن حالة طلبي الأخير ومتى بيوصل. طيب، إذا بدك شي حكيني. يالله bye bye.";
    expect(looksLikePromptEcho(real, prompt)).toBe(false);
  });

  it("does not flag a short genuine greeting", () => {
    expect(looksLikePromptEcho("ألو، صباح الخير.", prompt)).toBe(false);
  });

  it("is inert when no prompt was sent", () => {
    expect(looksLikePromptEcho("ألو، كيفك؟ يالله، هلق بشوفلك ياها.", null)).toBe(false);
  });
});
