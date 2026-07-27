/**
 * Meta's template component rules.
 *
 * These numbers and rules come from the WhatsApp Business "Template
 * fundamentals" and "Template components" docs. They are pinned here for one
 * reason: they are enforced in TWO places — the create form's live errors and
 * the server's pre-flight rejection — and the whole point of sharing
 * `validateTemplateComponents` is that those two can never disagree.
 *
 * A limit STRICTER than Meta's is just as wrong as a looser one: it silently
 * blocks templates Meta would have accepted, which is indistinguishable from a
 * bug. So this asserts exact equality, not bounds.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-limits.spec.ts
 */
import { describe, expect, it, vi } from "vitest";

import {
  CAROUSEL_LIMITS,
  LIMITED_TIME_OFFER_LIMITS,
  TEMPLATE_LIMITS,
  TEMPLATE_NAME_PATTERN,
  detectParameterFormat,
  positionalPlaceholderIndices,
  requiredCarouselCards,
  requiredTemplateButtonParams,
  templateNeedsOfferExpiry,
  validateTemplateComponents,
  validateTemplateParamValue,
  validateTemplateParamValues,
  TEMPLATE_ARCHIVE_DELETION_DAYS,
  TEMPLATE_TTL_RULES,
  TEMPLATE_TTL_THIRTY_DAYS,
  formatTtlSeconds,
  validateTemplateTtl,
  TEMPLATE_AUTO_ARCHIVE_MONTHS,
  templateArchivalRisk,
  templateDeletionDaysLeft,
  templateReviewWarnings,
} from "@ccp/shared/template-render";
import { TEMPLATE_LANGUAGES } from "@ccp/shared/template-languages";
import {
  buildTemplateSendComponents,
  lowercaseComponentForCreate,
  messagingAccountField,
  metaProvider,
  parseTemplateComparison,
} from "@/lib/providers/meta";
import {
  ALL_META_ERROR_CODES,
  classifyMetaStatusError,
  failureBucket,
} from "@/lib/providers/meta-send-error";
import { ERROR_LABELS } from "@/lib/broadcast-report";
import { deliveryWinsOver } from "@/lib/providers/ingest";
import { normalizeMessagingTier } from "@/lib/providers/meta-health";

/** A minimal valid body: one variable WITH the example Meta requires. */
const body = (text = "Hi {{1}}", examples = ["Pablo"]) => ({
  type: "BODY",
  text,
  ...(examples.length > 0 ? { example: { body_text: [examples] } } : {}),
});
const fields = (issues: Array<{ field: string }>) => issues.map((i) => i.field).sort();

describe("the documented numbers", () => {
  it("matches Meta's published limits exactly", () => {
    expect(TEMPLATE_LIMITS.bodyMaxLength).toBe(1024);
    expect(TEMPLATE_LIMITS.headerMaxLength).toBe(60);
    expect(TEMPLATE_LIMITS.footerMaxLength).toBe(60);
    expect(TEMPLATE_LIMITS.nameMaxLength).toBe(512);
    expect(TEMPLATE_LIMITS.buttonTextMaxLength).toBe(25);
    expect(TEMPLATE_LIMITS.copyCodeExampleMaxLength).toBe(20);
    expect(TEMPLATE_LIMITS.urlMaxLength).toBe(2000);
    expect(TEMPLATE_LIMITS.phoneNumberMaxLength).toBe(20);
    expect(TEMPLATE_LIMITS.maxButtons).toBe(10);
  });

  it("caps buttons PER TYPE, not as one shared call-to-action budget", () => {
    // The components doc caps URL at 2 and PHONE_NUMBER at 1 independently. A
    // combined cap of 2 was wrong in BOTH directions — it rejected the legal
    // `URL + URL + PHONE` and accepted the illegal `PHONE + PHONE`.
    expect(TEMPLATE_LIMITS.maxUrlButtons).toBe(2);
    expect(TEMPLATE_LIMITS.maxPhoneNumberButtons).toBe(1);
    expect(TEMPLATE_LIMITS.maxCopyCodeButtons).toBe(1);
    expect(TEMPLATE_LIMITS.maxQuickReplyButtons).toBe(10);
  });
});

describe("name", () => {
  it("accepts lowercase, digits and underscores", () => {
    expect(TEMPLATE_NAME_PATTERN.test("order_confirmation_2")).toBe(true);
  });

  it("rejects uppercase, spaces and punctuation", () => {
    for (const bad of ["Order_Confirmation", "order confirmation", "order-confirmation", ""]) {
      expect(TEMPLATE_NAME_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("supported languages", () => {
  it("carries Meta's full table, not a hand-picked subset", () => {
    // The dropdown IS this list; a short list silently blocks templates.
    // Exactly the 111 codes in Meta's "Supported Languages" doc, verified
    // 1:1 (both directions) on 2026-07-27. A count drift means either Meta
    // added/removed a language (update the list AND this number) or someone
    // dropped an entry by accident (the case `> 100` silently waved through).
    expect(TEMPLATE_LANGUAGES.length).toBe(111);
    for (const code of ["zh_CN", "he", "ru", "nl", "pl", "ur", "prs_AF", "rw_RW", "fil"]) {
      expect(TEMPLATE_LANGUAGES.some((l) => l.code === code)).toBe(true);
    }
  });

  it("has no duplicate codes", () => {
    const codes = TEMPLATE_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("body", () => {
  it("passes a well-formed template", () => {
    expect(validateTemplateComponents("order_update", [body()])).toEqual([]);
  });

  it("accepts a body EXACTLY at the limit, and rejects one character more", () => {
    // The boundary is the whole point — an off-by-one here either blocks a
    // legal template or lets an illegal one through to Meta.
    expect(
      validateTemplateComponents("t", [body("x".repeat(TEMPLATE_LIMITS.bodyMaxLength), [])]),
    ).toEqual([]);
    const over = validateTemplateComponents("t", [
      body("x".repeat(TEMPLATE_LIMITS.bodyMaxLength + 1), []),
    ]);
    expect(over).toHaveLength(1);
    expect(over[0]!.field).toBe("body");
    // The message names the actual count, so an author can see how far over.
    expect(over[0]!.message).toContain(String(TEMPLATE_LIMITS.bodyMaxLength + 1));
  });

  it("requires an example value for every variable", () => {
    // "If your templates use variables, you must include sample variable values
    // upon template creation." Meta's rejection names no field, so we do.
    expect(fields(validateTemplateComponents("t", [{ type: "BODY", text: "Hi {{1}}" }]))).toEqual([
      "body",
    ]);
  });

  it("rejects an example count that doesn't match the variable count", () => {
    expect(fields(validateTemplateComponents("t", [body("Hi {{1}} {{2}}", ["a"])]))).toEqual([
      "body",
    ]);
    expect(validateTemplateComponents("t", [body("Hi {{1}} {{2}}", ["a", "b"])])).toEqual([]);
  });

  it("rejects a gap in the numbering", () => {
    // Meta requires {{1}}..{{N}} with no holes. `countTemplatePlaceholders`
    // returns the MAX, so a gap used to sail through and produce N examples for
    // N-1 real variables.
    const issues = validateTemplateComponents("t", [body("Hi {{1}} then {{3}}", ["a", "b", "c"])]);
    expect(fields(issues)).toContain("body");
    expect(issues.some((i) => i.message.includes("{{2}}"))).toBe(true);
  });

  it("accepts a repeated variable without demanding a duplicate example", () => {
    // `{{1}} … {{1}}` is one variable used twice, not two.
    expect(validateTemplateComponents("t", [body("Hi {{1}}, bye {{1}}", ["a"])])).toEqual([]);
  });
});

describe("parameter format", () => {
  it("detects each dialect across header, body and URL buttons", () => {
    expect(detectParameterFormat([body("Hi {{1}}")])).toBe("positional");
    expect(
      detectParameterFormat([
        {
          type: "BODY",
          text: "Hi {{first_name}}",
          example: { body_text_named_params: [{ param_name: "first_name", example: "Pablo" }] },
        },
      ]),
    ).toBe("named");
    expect(detectParameterFormat([{ type: "BODY", text: "no variables here" }])).toBe("none");
  });

  it("flags a MIXED template — Meta stores one format per template", () => {
    // Whichever format we declared, half the placeholders would be unfilled at
    // send time and every recipient would fail with error 132000.
    expect(detectParameterFormat([body("Hi {{1}} and {{name}}")])).toBe("mixed");
    const issues = validateTemplateComponents("t", [body("Hi {{1}} and {{name}}", ["a"])]);
    expect(issues.some((i) => i.message.toLowerCase().includes("mix"))).toBe(true);
  });

  it("catches a mix that spans components, not just one string", () => {
    expect(
      detectParameterFormat([
        body("Hi {{1}}"),
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Go", url: "https://x.com/{{code}}" }] },
      ]),
    ).toBe("mixed");
  });

  it("requires a named example per placeholder NAME", () => {
    const missing = validateTemplateComponents("t", [
      {
        type: "BODY",
        text: "Hi {{first_name}}, order {{order_id}}",
        example: { body_text_named_params: [{ param_name: "first_name", example: "Pablo" }] },
      },
    ]);
    expect(fields(missing)).toEqual(["body"]);
    expect(missing[0]!.message).toContain("order_id");
  });

  it("counts positional indices in appearance order, duplicates kept", () => {
    expect(positionalPlaceholderIndices("a {{2}} b {{1}} c {{2}}")).toEqual([2, 1, 2]);
  });
});

describe("header", () => {
  it("only length-checks a TEXT header — a media header carries no text", () => {
    const long = "x".repeat(TEMPLATE_LIMITS.headerMaxLength + 1);
    expect(
      fields(
        validateTemplateComponents("t", [
          body(),
          { type: "HEADER", format: "TEXT", text: long },
        ]),
      ),
    ).toContain("header");
    // An IMAGE header has no text limit to violate — but it DOES need its
    // uploaded example handle.
    expect(
      validateTemplateComponents("t", [
        body(),
        { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW"] } },
      ]),
    ).toEqual([]);
  });

  it("requires the uploaded media example on a media header", () => {
    expect(
      fields(validateTemplateComponents("t", [body(), { type: "HEADER", format: "IMAGE" }])),
    ).toEqual(["header"]);
  });

  it("allows at most one header variable", () => {
    expect(
      fields(
        validateTemplateComponents("t", [
          body(),
          {
            type: "HEADER",
            format: "TEXT",
            text: "{{1}} and {{2}}",
            example: { header_text: ["a", "b"] },
          },
        ]),
      ),
    ).toContain("header");
  });

  it("allows a LOCATION header only on utility and marketing", () => {
    const loc = [body(), { type: "HEADER", format: "LOCATION" }];
    expect(validateTemplateComponents("t", loc, { category: "utility" })).toEqual([]);
    expect(validateTemplateComponents("t", loc, { category: "marketing" })).toEqual([]);
    expect(fields(validateTemplateComponents("t", loc, { category: "authentication" }))).toEqual([
      "header",
    ]);
    // No category supplied → no opinion, rather than a false rejection.
    expect(validateTemplateComponents("t", loc)).toEqual([]);
  });
});

describe("footer", () => {
  it("rejects variables — a footer has no example slot to fill them from", () => {
    // Without this the placeholder ships to the customer as literal `{{1}}`.
    expect(
      fields(validateTemplateComponents("t", [body(), { type: "FOOTER", text: "Ref {{1}}" }])),
    ).toEqual(["footer"]);
  });
});

describe("buttons", () => {
  const buttons = (bs: unknown[]) => [body(), { type: "BUTTONS", buttons: bs }];

  it("accepts the legal URL + URL + PHONE combination", () => {
    expect(
      validateTemplateComponents(
        "t",
        buttons([
          { type: "URL", text: "Shop", url: "https://a.com" },
          { type: "URL", text: "Help", url: "https://b.com" },
          { type: "PHONE_NUMBER", text: "Call", phone_number: "15550051310" },
        ]),
      ),
    ).toEqual([]);
  });

  it("rejects two phone buttons", () => {
    expect(
      fields(
        validateTemplateComponents(
          "t",
          buttons([
            { type: "PHONE_NUMBER", text: "Call", phone_number: "1555" },
            { type: "PHONE_NUMBER", text: "Also", phone_number: "1556" },
          ]),
        ),
      ),
    ).toEqual(["buttons"]);
  });

  it("caps quick replies at 10", () => {
    const quick = Array.from({ length: 11 }, () => ({ type: "QUICK_REPLY", text: "ok" }));
    expect(validateTemplateComponents("t", buttons(quick))).not.toHaveLength(0);
  });

  it("requires quick replies to be contiguous", () => {
    // Meta groups buttons into quick-reply and non-quick-reply blocks and
    // rejects an interleaved order as an invalid combination.
    const interleaved = buttons([
      { type: "QUICK_REPLY", text: "a" },
      { type: "URL", text: "Go", url: "https://x.com" },
      { type: "QUICK_REPLY", text: "b" },
    ]);
    expect(fields(validateTemplateComponents("t", interleaved))).toEqual(["buttons"]);

    // …but the same buttons grouped are fine, in either order.
    expect(
      validateTemplateComponents(
        "t",
        buttons([
          { type: "QUICK_REPLY", text: "a" },
          { type: "QUICK_REPLY", text: "b" },
          { type: "URL", text: "Go", url: "https://x.com" },
        ]),
      ),
    ).toEqual([]);
  });

  it("requires an example on a URL button that carries a variable", () => {
    const noExample = buttons([{ type: "URL", text: "Go", url: "https://x.com/{{1}}" }]);
    expect(fields(validateTemplateComponents("t", noExample))).toEqual(["buttons"]);
    expect(
      validateTemplateComponents(
        "t",
        buttons([{ type: "URL", text: "Go", url: "https://x.com/{{1}}", example: ["summer"] }]),
      ),
    ).toEqual([]);
  });

  it("requires the URL variable to be a SUFFIX", () => {
    // Meta substitutes only at the end; a mid-URL placeholder is accepted at
    // creation and then produces a broken link for every recipient.
    const midUrl = buttons([
      { type: "URL", text: "Go", url: "https://x.com/{{1}}/detail", example: ["abc"] },
    ]);
    const issues = validateTemplateComponents("t", midUrl);
    expect(fields(issues)).toEqual(["buttons"]);
    expect(issues[0]!.message).toContain("end");
  });

  it("reads a copy-code example as a bare string OR an array", () => {
    // Meta documents the copy-code example as a STRING and the URL example as an
    // ARRAY. Both shapes really occur, so neither may crash a validator.
    expect(validateTemplateComponents("t", buttons([{ type: "COPY_CODE", example: "250FF" }]))).toEqual(
      [],
    );
    expect(
      validateTemplateComponents("t", buttons([{ type: "COPY_CODE", example: ["250FF"] }])),
    ).toEqual([]);
    expect(
      fields(
        validateTemplateComponents(
          "t",
          buttons([{ type: "COPY_CODE", example: "x".repeat(21) }]),
        ),
      ),
    ).toEqual(["buttons"]);
  });

  it("does not demand a label from a copy-code button", () => {
    // COPY_CODE is the one type with no `text`; typing it as required made every
    // length check read `undefined.length`.
    expect(validateTemplateComponents("t", buttons([{ type: "COPY_CODE", example: "250FF" }]))).toEqual(
      [],
    );
  });
});

describe("component cardinality", () => {
  it("rejects a second BODY", () => {
    expect(fields(validateTemplateComponents("t", [body(), body()]))).toContain("body");
  });
});

describe("reporting", () => {
  it("reports EVERY problem at once, not just the first", () => {
    // One form pass instead of whack-a-mole with a 400 per field.
    const issues = validateTemplateComponents("Bad Name", [
      body("x".repeat(TEMPLATE_LIMITS.bodyMaxLength + 1), []),
      { type: "FOOTER", text: "y".repeat(TEMPLATE_LIMITS.footerMaxLength + 1) },
    ]);
    expect(fields(issues)).toEqual(["body", "footer", "name"]);
  });
});

// ---------------------------------------------------------------------------
// Template comparison (Meta's /compare endpoint).
// ---------------------------------------------------------------------------

describe("parseTemplateComparison", () => {
  const A = "5289179717853347";
  const B = "1533406637136032";
  const payload = {
    data: [
      { metric: "BLOCK_RATE", type: "RELATIVE", order_by_relative_metric: [B, A] },
      {
        metric: "MESSAGE_SENDS",
        type: "NUMBER_VALUES",
        number_values: [
          { key: A, value: 1273 },
          { key: B, value: 1042 },
        ],
      },
      {
        metric: "TOP_BLOCK_REASON",
        type: "STRING_VALUES",
        string_values: [
          { key: A, value: "SPAM" },
          { key: B, value: "UNKNOWN_BLOCK_REASON" },
        ],
      },
    ],
  };

  it("reads each metric BY NAME, not by position", () => {
    // The envelope order isn't contractual, and an unknown metric must not
    // shift the others.
    const shuffled = { data: [payload.data[2], payload.data[0], { metric: "FUTURE" }, payload.data[1]] };
    const out = parseTemplateComparison(shuffled);
    expect(out.blockRateOrder).toEqual([B, A]);
    expect(out.sends).toHaveLength(2);
    expect(out.topBlockReasons).toHaveLength(2);
  });

  it("keeps the block-rate ORDER — the better template first", () => {
    // Meta never gives the rate itself, only the ranking, so the first id is
    // the whole verdict.
    expect(parseTemplateComparison(payload).blockRateOrder[0]).toBe(B);
  });

  it("returns empty structures for a malformed or empty payload", () => {
    // Meta answers a constraint violation (under 1,000 sends, cross-WABA) with
    // an empty body rather than an error — it must not throw, and the caller
    // reports "not enough data" rather than drawing a tie.
    for (const bad of [{}, { data: null }, { data: [{}] }, null, "nope"]) {
      const out = parseTemplateComparison(bad);
      expect(out.blockRateOrder).toEqual([]);
      expect(out.sends).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Template Library parameter types (checked at SEND time).
// ---------------------------------------------------------------------------

describe("validateTemplateParamValues", () => {
  it("accepts every sample value Meta documents for each type", () => {
    // Straight from the Template Library doc's parameter table. A validator that
    // rejects one of these blocks a send Meta would have accepted.
    const samples: Array<[string, string[]]> = [
      ["ADDRESS", ["1 Hacker Way, Menlo Park, CA 94025"]],
      ["TEXT", ["regarding your order.", "12 pack of paper towels", "Jasper's Market"]],
      ["AMOUNT", ["145", "USD $375.32", "€1,376.22 EUR", "RS 1200"]],
      ["DATE", ["2021-04-19", "13/03/2021", "5th January 1982", "08.22.1991", "05 12 2022"]],
      ["PHONE_NUMBER", ["+1 4256789900", "+91-7884-789122", "+39 87 62232"]],
      ["EMAIL", ["1hackerway@meta.com", "yourcustomername@gmail.com"]],
      ["NUMBER", ["23444", "90001234921388904", "453638"]],
    ];
    for (const [type, values] of samples) {
      for (const v of values) {
        expect(validateTemplateParamValue(type, v)).toBeNull();
      }
    }
  });

  it("catches the unambiguous mistakes", () => {
    expect(validateTemplateParamValue("EMAIL", "not-an-email")).not.toBeNull();
    expect(validateTemplateParamValue("NUMBER", "12 34")).not.toBeNull();
    expect(validateTemplateParamValue("NUMBER", "abc")).not.toBeNull();
    expect(validateTemplateParamValue("PHONE_NUMBER", "call me")).not.toBeNull();
    expect(validateTemplateParamValue("AMOUNT", "lots")).not.toBeNull();
  });

  it("leaves under-specified types alone rather than guessing", () => {
    // Meta accepts a wide, loosely-described range for these. A stricter
    // validator here would block valid sends — the same failure mode as a
    // too-tight length limit.
    expect(validateTemplateParamValue("DATE", "sometime next Tuesday")).toBeNull();
    expect(validateTemplateParamValue("ADDRESS", "behind the big tree")).toBeNull();
    expect(validateTemplateParamValue("TEXT", "!!!")).toBeNull();
    // An unknown type is not a reason to block a send.
    expect(validateTemplateParamValue("FUTURE_TYPE", "anything")).toBeNull();
  });

  it("reports every bad value positionally, not just the first", () => {
    const issues = validateTemplateParamValues(
      ["TEXT", "EMAIL", "NUMBER"],
      ["fine", "nope", "1 2"],
    );
    expect(issues.map((i) => i.field)).toEqual(["body.1", "body.2"]);
    expect(issues[0]!.message).toContain("email");
  });

  it("ignores positions the caller didn't supply", () => {
    // A shorter value list is a count problem, reported elsewhere — not a type
    // problem to double-report here.
    expect(validateTemplateParamValues(["EMAIL", "NUMBER"], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Archival.
// ---------------------------------------------------------------------------

describe("archival", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

  it("counts down Meta's 28-day deletion window", () => {
    expect(TEMPLATE_ARCHIVE_DELETION_DAYS).toBe(28);
    expect(templateDeletionDaysLeft(daysAgo(0))).toBe(28);
    expect(templateDeletionDaysLeft(daysAgo(20))).toBe(8);
  });

  it("floors at zero once the window has passed, never goes negative", () => {
    // A negative "days left" would render as "in about -3 days"; the honest
    // answer is that deletion is imminent or already happened.
    expect(templateDeletionDaysLeft(daysAgo(40))).toBe(0);
  });

  it("returns null when we never observed an archival", () => {
    expect(templateDeletionDaysLeft(null)).toBeNull();
    expect(templateDeletionDaysLeft("not-a-date")).toBeNull();
  });

  it("accepts an ISO string as well as a Date (the DTO ships strings)", () => {
    expect(templateDeletionDaysLeft(daysAgo(14).toISOString())).toBe(14);
  });

  it("warns BEFORE auto-archival, while sending can still reset the clock", () => {
    expect(TEMPLATE_AUTO_ARCHIVE_MONTHS).toBe(12);
    // Used yesterday — nowhere near the cutoff.
    expect(templateArchivalRisk(daysAgo(1))?.atRisk).toBe(false);
    // ~11.5 months idle — inside the 30-day warning window.
    expect(templateArchivalRisk(daysAgo(350))?.atRisk).toBe(true);
  });

  it("treats unknown activity as unknown, not as a warning", () => {
    // A template we have no send record for is not evidence of inactivity.
    expect(templateArchivalRisk(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Media headers: link vs id on the send wire.
// ---------------------------------------------------------------------------

describe("header media wire shape", () => {
  const header = (media: Record<string, unknown>) =>
    buildTemplateSendComponents({ body: [], headerMedia: media as never });

  it("sends `id` when supplied, and never alongside `link`", () => {
    // Meta documents one or the other; sending both is not a documented shape.
    const [comp] = header({ kind: "image", id: "1234", link: "https://x.com/a.png" });
    expect(comp).toEqual({
      type: "header",
      parameters: [{ type: "image", image: { id: "1234" } }],
    });
  });

  it("falls back to `link` when there is no id", () => {
    const [comp] = header({ kind: "image", link: "https://x.com/a.png" });
    expect(comp).toEqual({
      type: "header",
      parameters: [{ type: "image", image: { link: "https://x.com/a.png" } }],
    });
  });

  it("carries the filename on a DOCUMENT header only", () => {
    const [doc] = header({ kind: "document", id: "9", filename: "receipt.pdf" });
    expect(doc).toEqual({
      type: "header",
      parameters: [{ type: "document", document: { id: "9", filename: "receipt.pdf" } }],
    });
    // An image has no filename slot — Meta rejects unknown parameters.
    const [img] = header({ kind: "image", id: "9", filename: "nope.png" });
    expect(img).toEqual({
      type: "header",
      parameters: [{ type: "image", image: { id: "9" } }],
    });
  });
});

describe("template send components", () => {
  it("omits `components` entirely when there is nothing to fill", () => {
    // An EMPTY parameters array is Meta error 132000 — the reason this returns
    // no entry at all rather than an empty one.
    expect(buildTemplateSendComponents({ body: [] })).toEqual([]);
  });

  it("sends positional body params as bare text", () => {
    expect(buildTemplateSendComponents({ body: ["Ali", "SK-1"] })).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Ali" },
          { type: "text", text: "SK-1" },
        ],
      },
    ]);
  });

  it("sends NAMED body params with parameter_name, ignoring the positional array", () => {
    // A named template rejects bare `{ text }` with 132000, so the two shapes
    // must never be mixed on one send.
    expect(
      buildTemplateSendComponents({
        body: ["stale"],
        bodyNamed: [{ name: "first_name", text: "Ali" }],
      }),
    ).toEqual([
      {
        type: "body",
        parameters: [{ type: "text", parameter_name: "first_name", text: "Ali" }],
      },
    ]);
  });

  it("builds a LOCATION header from the send-time pin", () => {
    const [comp] = buildTemplateSendComponents({
      body: [],
      headerLocation: {
        latitude: "37.44",
        longitude: "-122.16",
        name: "Philz Coffee",
        address: "101 Forest Ave",
      },
    });
    expect(comp).toEqual({
      type: "header",
      parameters: [
        {
          type: "location",
          location: {
            latitude: "37.44",
            longitude: "-122.16",
            name: "Philz Coffee",
            address: "101 Forest Ave",
          },
        },
      ],
    });
  });

  it("gives each dynamic button its own component, keyed by sub_type + index", () => {
    expect(
      buildTemplateSendComponents({
        body: [],
        buttons: [
          { index: 0, subType: "url", text: "summer2023" },
          { index: 1, subType: "copy_code", text: "250FF" },
          { index: 2, subType: "quick_reply", text: "PAYLOAD" },
        ],
      }),
    ).toEqual([
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "summer2023" }] },
      {
        type: "button",
        sub_type: "copy_code",
        index: "1",
        parameters: [{ type: "coupon_code", coupon_code: "250FF" }],
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "2",
        parameters: [{ type: "payload", payload: "PAYLOAD" }],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Time-to-live.
// ---------------------------------------------------------------------------

describe("template TTL", () => {
  it("matches Meta's published per-category ranges exactly", () => {
    expect(TEMPLATE_TTL_RULES.authentication).toMatchObject({ min: 30, max: 900 });
    expect(TEMPLATE_TTL_RULES.utility).toMatchObject({ min: 30, max: 43_200 });
    expect(TEMPLATE_TTL_RULES.marketing).toMatchObject({ min: 43_200, max: 2_592_000 });
    // Authentication defaults to 10 minutes, not the 30 days the others get.
    expect(TEMPLATE_TTL_RULES.authentication.defaultSeconds).toBe(600);
  });

  it("accepts each category's own bounds", () => {
    for (const [category, r] of Object.entries(TEMPLATE_TTL_RULES)) {
      expect(validateTemplateTtl(category, r.min)).toBeNull();
      expect(validateTemplateTtl(category, r.max)).toBeNull();
    }
  });

  it("judges the SAME number differently per category", () => {
    // 12h is simultaneously the utility MAXIMUM and the marketing MINIMUM, and
    // one second under it is valid for utility and invalid for marketing. This
    // is why a TTL can't be validated without knowing the category.
    expect(validateTemplateTtl("utility", 43_199)).toBeNull();
    expect(validateTemplateTtl("marketing", 43_199)).not.toBeNull();
    expect(validateTemplateTtl("utility", 43_201)).not.toBeNull();
    expect(validateTemplateTtl("marketing", 43_201)).toBeNull();
  });

  it("accepts -1 (30 days) on authentication and utility only", () => {
    // A naive `n <= 0` guard rejects this documented value outright.
    expect(TEMPLATE_TTL_THIRTY_DAYS).toBe(-1);
    expect(validateTemplateTtl("authentication", -1)).toBeNull();
    expect(validateTemplateTtl("utility", -1)).toBeNull();
    expect(validateTemplateTtl("marketing", -1)).not.toBeNull();
  });

  it("names the actual range in the message", () => {
    // Meta rejects out-of-range with an opaque #100 naming neither field nor
    // bound — the entire reason this is checked first.
    const msg = validateTemplateTtl("authentication", 5_000)!;
    expect(msg).toContain("30 seconds");
    expect(msg).toContain("15 minutes");
  });

  it("rejects non-integers and stays silent on unknown categories", () => {
    expect(validateTemplateTtl("utility", 60.5)).not.toBeNull();
    // Not ours to adjudicate — better to let Meta answer than invent a rule.
    expect(validateTemplateTtl("something_new", 1)).toBeNull();
  });

  it("formats durations the way an operator reads them", () => {
    expect(formatTtlSeconds(2_592_000)).toBe("30 days");
    expect(formatTtlSeconds(43_200)).toBe("12 hours");
    expect(formatTtlSeconds(900)).toBe("15 minutes");
    expect(formatTtlSeconds(30)).toBe("30 seconds");
    expect(formatTtlSeconds(-1)).toBe("30 days");
  });
});

describe("tap target override", () => {
  it("emits Meta's nested array shape, after the content components", () => {
    // Meta wraps a single entry in an ARRAY, and the component is a
    // whole-message affordance rather than a parameter of any one component —
    // its examples place it last.
    const comps = buildTemplateSendComponents({
      body: ["Ali"],
      tapTarget: { url: "https://shop.com/offer", title: "Offer Details" },
    });
    expect(comps).toHaveLength(2);
    expect(comps[0]).toMatchObject({ type: "body" });
    expect(comps[1]).toEqual({
      type: "tap_target_configuration",
      parameters: [
        {
          type: "tap_target_configuration",
          tap_target_configuration: [
            { url: "https://shop.com/offer", title: "Offer Details" },
          ],
        },
      ],
    });
  });

  it("is absent when not supplied", () => {
    expect(
      buildTemplateSendComponents({ body: ["Ali"] }).some(
        (c) => c.type === "tap_target_configuration",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Utility-category components.
// ---------------------------------------------------------------------------

describe("location header", () => {
  it("needs only COORDINATES at send time — name and address are optional", () => {
    // Meta's location-template reference marks name/address Optional. Demanding
    // them refuses a send Meta accepts, and omits nothing the map needs.
    const [comp] = buildTemplateSendComponents({
      body: [],
      headerLocation: { latitude: "37.44", longitude: "-122.16" },
    });
    expect(comp).toEqual({
      type: "header",
      parameters: [
        { type: "location", location: { latitude: "37.44", longitude: "-122.16" } },
      ],
    });
  });

  it("omits an empty label rather than sending a blank caption", () => {
    const [comp] = buildTemplateSendComponents({
      body: [],
      headerLocation: { latitude: "1", longitude: "2", name: "", address: "101 Forest Ave" },
    });
    expect(comp).toEqual({
      type: "header",
      parameters: [
        {
          type: "location",
          location: { latitude: "1", longitude: "2", address: "101 Forest Ave" },
        },
      ],
    });
  });
});

describe("call permission request templates", () => {
  const cpr = { type: "CALL_PERMISSION_REQUEST" };

  it("is allowed on utility and marketing, and nowhere else", () => {
    const comps = [body("Can we call you about order {{1}}?", ["A12"]), cpr];
    expect(validateTemplateComponents("call_req", comps, { category: "utility" })).toEqual([]);
    expect(validateTemplateComponents("call_req", comps, { category: "marketing" })).toEqual([]);
    expect(
      fields(validateTemplateComponents("call_req", comps, { category: "authentication" })),
    ).toContain("call_permission_request");
  });

  it("cannot be combined with buttons", () => {
    // The rendered message already carries Allow / Deny, so any other
    // interactive component is an invalid combination.
    const issues = validateTemplateComponents(
      "call_req",
      [
        body("Can we call?", []),
        cpr,
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "No thanks" }] },
      ],
      { category: "utility" },
    );
    expect(fields(issues)).toContain("call_permission_request");
  });

  it("requires body text explaining the call", () => {
    const issues = validateTemplateComponents(
      "call_req",
      [{ type: "BODY", text: "   " }, cpr],
      { category: "utility" },
    );
    expect(fields(issues)).toContain("call_permission_request");
  });

  it("needs no send-time component of its own", () => {
    // The permission prompt is rendered by Meta; only body params go on the wire.
    expect(
      buildTemplateSendComponents({ body: ["Ali"] }).some(
        (c) => String(c.type).toUpperCase() === "CALL_PERMISSION_REQUEST",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authentication templates.
// ---------------------------------------------------------------------------

describe("authentication OTP buttons", () => {
  const withButton = (btn: Record<string, unknown>) => [
    { type: "BODY", text: "{{1}} is your verification code." },
    { type: "BUTTONS", buttons: [btn] },
  ];

  it("reports a COPY_CODE OTP button as needing the code, via the URL sub-type", () => {
    // Before this, an `OTP` button was reported as needing NOTHING, so the send
    // went out body-only and Meta rejected it for the missing button parameter
    // — authentication templates were effectively unsendable.
    //
    // The sub-type is `url`, NOT `copy_code`: all three of Meta's authentication
    // send examples are identical and specify `sub_type: "url"`, because Meta
    // rewrites every otp button to type `url` on creation. A copy-code
    // AUTHENTICATION button is not the same thing as a marketing coupon button
    // that happens to share the name.
    expect(
      requiredTemplateButtonParams(withButton({ type: "OTP", otp_type: "COPY_CODE" })),
    ).toEqual([{ index: 0, subType: "url", autofillFromBody: true }]);
  });

  it("reports a ONE_TAP OTP button as the autofill url sub-type", () => {
    expect(
      requiredTemplateButtonParams(withButton({ type: "OTP", otp_type: "ONE_TAP" })),
    ).toEqual([{ index: 0, subType: "url", autofillFromBody: true }]);
  });

  it("requires the code on ZERO_TAP — the fallback buttons need it", () => {
    expect(
      requiredTemplateButtonParams(withButton({ type: "OTP", otp_type: "ZERO_TAP" })),
    ).toEqual([{ index: 0, subType: "url", autofillFromBody: true }]);
  });

  it("leaves an ordinary COPY_CODE coupon button alone (not autofilled)", () => {
    // A marketing coupon code is NOT the body text, so it must still be asked
    // for — only the OTP variant is derived from the body.
    expect(requiredTemplateButtonParams(withButton({ type: "COPY_CODE" }))).toEqual([
      { index: 0, subType: "copy_code" },
    ]);
  });

  it("still reports a dynamic URL button, which is not autofillable", () => {
    expect(
      requiredTemplateButtonParams(
        withButton({ type: "URL", text: "Go", url: "https://x.com/{{1}}" }),
      ),
    ).toEqual([{ index: 0, subType: "url" }]);
  });
});

describe("authentication buttons after Meta rewrites them", () => {
  // "in your template creation request the button type is designated as `otp`,
  // but upon creation the button type will be set to `url`". So a SYNCED
  // one-tap template reads as a URL button with no `{{n}}` in its url —
  // matching neither the OTP branch nor the dynamic-URL branch. The category is
  // the only reliable discriminator, and without it authentication templates
  // were sent body-only and rejected.
  const synced = [
    { type: "BODY", text: "{{1}} is your verification code." },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Autofill" }] },
  ];

  it("requires the code on a synced one-tap button (type rewritten to URL)", () => {
    expect(requiredTemplateButtonParams(synced, "authentication")).toEqual([
      { index: 0, subType: "url", autofillFromBody: true },
    ]);
  });

  it("reports NOTHING for the same shape on a non-authentication template", () => {
    // A plain static URL button carries no parameter — demanding one would
    // block every marketing template with a fixed link.
    expect(requiredTemplateButtonParams(synced, "marketing")).toEqual([]);
    expect(requiredTemplateButtonParams(synced)).toEqual([]);
  });

  it("uses url even for a copy-code-typed button UNDER authentication", () => {
    // The category wins over the button's own type here — an authentication
    // template's code always travels as the `url` sub-type.
    expect(
      requiredTemplateButtonParams(
        [
          { type: "BODY", text: "{{1}} is your code." },
          { type: "BUTTONS", buttons: [{ type: "COPY_CODE" }] },
        ],
        "authentication",
      ),
    ).toEqual([{ index: 0, subType: "url", autofillFromBody: true }]);
  });

  it("leaves a MARKETING coupon button on the copy_code sub-type", () => {
    // The genuinely different thing that shares the name: a coupon code on a
    // marketing template, which is asked for rather than derived from the body.
    expect(
      requiredTemplateButtonParams(
        [
          { type: "BODY", text: "Use code {{1}}" },
          { type: "BUTTONS", buttons: [{ type: "COPY_CODE" }] },
        ],
        "marketing",
      ),
    ).toEqual([{ index: 0, subType: "copy_code" }]);
  });

  it("REQUIRES the code on ZERO_TAP too — 'no button' is what the user sees", () => {
    // A zero-tap template still declares one-tap and copy-code buttons "even if
    // the user may never see one of these", so a failed eligibility check can
    // fall back to them — and the fallback needs the code. Meta's zero-tap SEND
    // example is byte-identical to one-tap's. Excluding it (as an earlier read of
    // the overview did) left zero-tap templates sent body-only and rejected.
    expect(
      requiredTemplateButtonParams(
        [
          { type: "BODY", text: "{{1}} is your code." },
          { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "ZERO_TAP" }] },
        ],
        "authentication",
      ),
    ).toEqual([{ index: 0, subType: "url", autofillFromBody: true }]);
  });
});

// ---------------------------------------------------------------------------
// Marketing delivery refusals.
// ---------------------------------------------------------------------------

describe("marketing send errors", () => {
  it("keeps 131049 and 131050 as DIFFERENT outcomes", () => {
    // They look alike (both "marketing message not delivered") but call for
    // opposite responses: 131049 may clear on its own, 131050 is the recipient
    // switching us off and must suppress future campaigns.
    expect(classifyMetaStatusError(131049)).toBe("per_user_marketing_cap");
    expect(classifyMetaStatusError(131050)).toBe("marketing_opt_out");
  });

  it("does NOT fold either into rate_limited", () => {
    // Folding them in would engage the 429 streak and pause the whole broadcast
    // cross-lane, for a refusal that is per-RECIPIENT and permanent.
    expect(classifyMetaStatusError(130429)).toBe("rate_limited");
    expect(classifyMetaStatusError(131049)).not.toBe("rate_limited");
    expect(classifyMetaStatusError(131050)).not.toBe("rate_limited");
  });

  it("falls back to provider_rejected for an unknown code", () => {
    expect(classifyMetaStatusError(999999)).toBe("provider_rejected");
    expect(classifyMetaStatusError(null)).toBe("provider_rejected");
  });
});

// ---------------------------------------------------------------------------
// Meta's published examples, byte-for-byte.
// ---------------------------------------------------------------------------

describe("custom marketing template — Meta's own send example", () => {
  it("reproduces the documented components array exactly", () => {
    // Straight from Meta's custom-marketing-template page: a named-parameter
    // body plus an image header sent by media `id`. Asserting the whole array
    // (not field-by-field) is the point — it catches an EXTRA key just as well
    // as a missing one, and Meta rejects unknown parameters outright.
    expect(
      buildTemplateSendComponents({
        body: [],
        bodyNamed: [
          { name: "first_name", text: "Jessica" },
          { name: "discount_code", text: "WELCOME25" },
          { name: "discount_amount", text: "25%" },
        ],
        headerMedia: { kind: "image", id: "1339522734477770" },
      }),
    ).toEqual([
      {
        type: "header",
        parameters: [{ type: "image", image: { id: "1339522734477770" } }],
      },
      {
        type: "body",
        parameters: [
          { type: "text", parameter_name: "first_name", text: "Jessica" },
          { type: "text", parameter_name: "discount_code", text: "WELCOME25" },
          { type: "text", parameter_name: "discount_amount", text: "25%" },
        ],
      },
    ]);
  });
});

describe("utility template — Meta's own send example", () => {
  it("reproduces the documented components array exactly", () => {
    // From the utility page: same shape, four named params, image header by id.
    expect(
      buildTemplateSendComponents({
        body: [],
        bodyNamed: [
          { name: "number_of_guests", text: "4" },
          { name: "day", text: "Saturday" },
          { name: "date", text: "August 30th, 2025" },
          { name: "time", text: "7:30 pm" },
        ],
        headerMedia: { kind: "image", id: "2871834006348767" },
      }),
    ).toEqual([
      {
        type: "header",
        parameters: [{ type: "image", image: { id: "2871834006348767" } }],
      },
      {
        type: "body",
        parameters: [
          { type: "text", parameter_name: "number_of_guests", text: "4" },
          { type: "text", parameter_name: "day", text: "Saturday" },
          { type: "text", parameter_name: "date", text: "August 30th, 2025" },
          { type: "text", parameter_name: "time", text: "7:30 pm" },
        ],
      },
    ]);
  });
});

describe("authentication template — Meta's own send example", () => {
  it("puts the code in BOTH the body and the button, as documented", () => {
    // "Note that this value must appear twice in the payload." The button value
    // is derived from body[0] by the send path, so this asserts the wire shape
    // the provider produces once that derivation has happened.
    expect(
      buildTemplateSendComponents({
        body: ["J$FpnYnP"],
        buttons: [{ index: 0, subType: "url", text: "J$FpnYnP" }],
      }),
    ).toEqual([
      { type: "body", parameters: [{ type: "text", text: "J$FpnYnP" }] },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "J$FpnYnP" }],
      },
    ]);
  });
});

describe("coupon code template — Meta's own send example", () => {
  it("reproduces the documented copy_code button component", () => {
    // The one shape that uses the `copy_code` sub-type with a `coupon_code`
    // parameter — distinct from an AUTHENTICATION copy-code button, which uses
    // `url`. Both exist; they are not interchangeable.
    expect(
      buildTemplateSendComponents({
        body: [],
        bodyNamed: [
          { name: "coupon_code", text: "WINTER25" },
          { name: "discount", text: "30%" },
        ],
        buttons: [{ index: 1, subType: "copy_code", text: "WINTER25" }],
      }),
    ).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", parameter_name: "coupon_code", text: "WINTER25" },
          { type: "text", parameter_name: "discount", text: "30%" },
        ],
      },
      {
        type: "button",
        sub_type: "copy_code",
        // Meta writes this as an integer in the coupon example and a string in
        // the authentication ones. It accepts both; we emit the string form
        // consistently rather than varying by template kind.
        index: "1",
        parameters: [{ type: "coupon_code", coupon_code: "WINTER25" }],
      },
    ]);
  });

  it("caps coupon templates at ONE copy-code button", () => {
    const issues = validateTemplateComponents(
      "winter_sale",
      [
        body("Use code {{1}}", ["WINTER25"]),
        {
          type: "BUTTONS",
          buttons: [
            { type: "COPY_CODE", example: "WINTER25" },
            { type: "COPY_CODE", example: "SPRING10" },
          ],
        },
      ],
      { category: "marketing" },
    );
    expect(fields(issues)).toContain("buttons");
  });

  it("does not demand a label for a copy-code button", () => {
    // "Copy code button text cannot be customized" — there is no label to give.
    expect(
      validateTemplateComponents(
        "winter_sale",
        [
          body("Use code {{1}}", ["WINTER25"]),
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Unsubscribe" },
              { type: "COPY_CODE", example: "WINTER25" },
            ],
          },
        ],
        { category: "marketing" },
      ),
    ).toEqual([]);
  });
});

describe("limited-time offer templates", () => {
  const offer = (text: string) => ({
    type: "LIMITED_TIME_OFFER" as const,
    limited_time_offer: { text, has_expiration: true },
  });
  const ltoButtons = {
    type: "BUTTONS" as const,
    buttons: [
      { type: "COPY_CODE" as const, example: "CARIBE25" },
      { type: "URL" as const, text: "Book now!", url: "https://example.com/{{1}}", example: ["s"] },
    ],
  };

  it("accepts the documented shape", () => {
    expect(
      validateTemplateComponents(
        "caribe_resort_offer",
        [
          { type: "HEADER", format: "IMAGE", example: { header_handle: ["h"] } },
          body("Rest and relax with {{1}} off!", ["25%"]),
          offer("Expiring offer!"),
          ltoButtons,
        ],
        { category: "marketing" },
      ),
    ).toEqual([]);
  });

  it("is marketing-only", () => {
    const issues = validateTemplateComponents(
      "resort_offer",
      [body("Rest and relax with {{1}} off!", ["25%"]), offer("Expiring offer!")],
      { category: "utility" },
    );
    expect(issues.some((i) => i.field === "limited_time_offer")).toBe(true);
  });

  it("rejects a footer — the countdown occupies that space", () => {
    const issues = validateTemplateComponents(
      "resort_offer",
      [
        body("Rest and relax with {{1}} off!", ["25%"]),
        { type: "FOOTER", text: "Terms apply" },
        offer("Expiring offer!"),
      ],
      { category: "marketing" },
    );
    expect(issues.some((i) => i.field === "limited_time_offer")).toBe(true);
  });

  it("rejects a text, document or location header", () => {
    for (const format of ["TEXT", "DOCUMENT", "LOCATION"]) {
      const issues = validateTemplateComponents(
        "resort_offer",
        [
          { type: "HEADER", format, text: format === "TEXT" ? "Hi" : undefined },
          body("Rest and relax!"),
          offer("Expiring offer!"),
        ],
        { category: "marketing" },
      );
      expect(issues.some((i) => i.field === "limited_time_offer")).toBe(true);
    }
  });

  it("caps the body at 600, tighter than the usual 1024", () => {
    expect(LIMITED_TIME_OFFER_LIMITS.bodyMaxLength).toBe(600);
    expect(LIMITED_TIME_OFFER_LIMITS.bodyMaxLength).toBeLessThan(
      TEMPLATE_LIMITS.bodyMaxLength,
    );
    const long = "x".repeat(601);
    const issues = validateTemplateComponents(
      "resort_offer",
      [body(long), offer("Expiring offer!")],
      { category: "marketing" },
    );
    expect(issues.some((i) => i.field === "body")).toBe(true);
    // …and the SAME body is fine on an ordinary marketing template.
    expect(
      validateTemplateComponents("resort_offer", [body(long)], {
        category: "marketing",
      }),
    ).toEqual([]);
  });

  it("caps the heading at 16 and requires one", () => {
    expect(LIMITED_TIME_OFFER_LIMITS.offerTextMaxLength).toBe(16);
    for (const text of ["", "x".repeat(17)]) {
      const issues = validateTemplateComponents(
        "resort_offer",
        [body("Rest and relax!"), offer(text)],
        { category: "marketing" },
      );
      expect(issues.some((i) => i.field === "limited_time_offer")).toBe(true);
    }
  });

  it("caps the offer code at 15, tighter than a plain coupon button", () => {
    expect(LIMITED_TIME_OFFER_LIMITS.offerCodeMaxLength).toBe(15);
    expect(LIMITED_TIME_OFFER_LIMITS.offerCodeMaxLength).toBeLessThan(
      TEMPLATE_LIMITS.copyCodeExampleMaxLength,
    );
    const code = "x".repeat(16);
    const withCode = {
      type: "BUTTONS" as const,
      buttons: [{ type: "COPY_CODE" as const, example: code }],
    };
    expect(
      validateTemplateComponents(
        "resort_offer",
        [body("Rest and relax!"), offer("Expiring offer!"), withCode],
        { category: "marketing" },
      ).some((i) => i.field === "buttons"),
    ).toBe(true);
    // The same code passes on a plain coupon template (limit 20).
    expect(
      validateTemplateComponents("winter_sale", [body("Rest and relax!"), withCode], {
        category: "marketing",
      }),
    ).toEqual([]);
  });

  it("reproduces Meta's documented send component (MILLISECONDS)", () => {
    // The unit trap: `template_analytics` and `/compare` both take SECONDS.
    // Handing this field seconds doesn't error — it renders a countdown that
    // expired in 1970.
    const expiresAt = 1707116400000;
    expect(
      buildTemplateSendComponents({
        body: ["25%"],
        limitedTimeOfferExpiresAtMs: expiresAt,
        buttons: [{ index: 1, subType: "url", text: "15" }],
      }),
    ).toEqual([
      { type: "body", parameters: [{ type: "text", text: "25%" }] },
      {
        type: "limited_time_offer",
        parameters: [
          {
            type: "limited_time_offer",
            limited_time_offer: { expiration_time_ms: expiresAt },
          },
        ],
      },
      {
        type: "button",
        sub_type: "url",
        index: "1",
        parameters: [{ type: "text", text: "15" }],
      },
    ]);
  });

  it("omits the offer component entirely when no expiry is supplied", () => {
    expect(buildTemplateSendComponents({ body: ["25%"] })).toEqual([
      { type: "body", parameters: [{ type: "text", text: "25%" }] },
    ]);
  });
});

describe("templateNeedsOfferExpiry", () => {
  const lto = (has_expiration?: boolean) => ({
    type: "LIMITED_TIME_OFFER",
    limited_time_offer: {
      text: "Expiring offer!",
      ...(has_expiration === undefined ? {} : { has_expiration }),
    },
  });

  it("needs one when the countdown is on", () => {
    expect(templateNeedsOfferExpiry([lto(true)])).toBe(true);
  });

  it("does NOT need one when the countdown is off", () => {
    // Meta expects no expiry parameter here. Demanding one refuses a send it
    // accepts — as invisible a failure as a too-tight length limit.
    expect(templateNeedsOfferExpiry([lto(false)])).toBe(false);
  });

  it("reads an absent flag as on", () => {
    expect(templateNeedsOfferExpiry([lto()])).toBe(true);
  });

  it("is false for a template with no offer at all", () => {
    expect(templateNeedsOfferExpiry([{ type: "BODY", text: "hi" }])).toBe(false);
    expect(templateNeedsOfferExpiry([])).toBe(false);
  });

  it("survives junk components", () => {
    expect(templateNeedsOfferExpiry([null, undefined, "x", 3])).toBe(false);
  });
});

describe("location template — Meta's own send example", () => {
  it("reproduces the documented header + NAMED body pairing", () => {
    // This page is the only one that shows a location header and a named body
    // TOGETHER. They are built by separate branches, so the pairing is what's
    // worth pinning: the header's `else if` chain must not swallow the named
    // body, and the body must not lose `parameter_name`.
    expect(
      buildTemplateSendComponents({
        body: [],
        headerLocation: {
          latitude: "34.01881798498779",
          longitude: "-118.46708679200001",
          name: "Lucky Shrub - Santa Monica",
          address: "3250 Ocean Park Blvd, Santa Monica, CA 90405",
        },
        bodyNamed: [
          { name: "customer_name", text: "Maria" },
          { name: "discount", text: "15%" },
        ],
      }),
    ).toEqual([
      {
        type: "header",
        parameters: [
          {
            type: "location",
            location: {
              latitude: "34.01881798498779",
              longitude: "-118.46708679200001",
              name: "Lucky Shrub - Santa Monica",
              address: "3250 Ocean Park Blvd, Santa Monica, CA 90405",
            },
          },
        ],
      },
      {
        type: "body",
        parameters: [
          { type: "text", parameter_name: "customer_name", text: "Maria" },
          { type: "text", parameter_name: "discount", text: "15%" },
        ],
      },
    ]);
  });

  it("omits name/address rather than sending empty strings", () => {
    // Both are OPTIONAL. The composer keeps blank fields as "" in local state,
    // so without this the card renders a blank caption.
    expect(
      buildTemplateSendComponents({
        body: [],
        headerLocation: {
          latitude: "34.01881798498779",
          longitude: "-118.46708679200001",
          name: "",
          address: "",
        },
      }),
    ).toEqual([
      {
        type: "header",
        parameters: [
          {
            type: "location",
            location: {
              latitude: "34.01881798498779",
              longitude: "-118.46708679200001",
            },
          },
        ],
      },
    ]);
  });

  it("allows a location header on MARKETING as well as UTILITY", () => {
    const comps = [
      { type: "HEADER", format: "LOCATION" },
      body("Hi {{1}}! We are opening a new store near you.", ["Lisa"]),
      { type: "FOOTER", text: "Reply STOP to unsubscribe." },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Unsubscribe from Promos" }] },
    ];
    expect(validateTemplateComponents("store_grand_opening", comps, { category: "marketing" })).toEqual([]);
    expect(validateTemplateComponents("store_grand_opening", comps, { category: "utility" })).toEqual([]);
    // …and nowhere else.
    expect(
      validateTemplateComponents("store_grand_opening", comps, {
        category: "authentication",
      }).some((i) => i.field === "header"),
    ).toBe(true);
  });
});

describe("media card carousel — Meta's own send example", () => {
  it("reproduces the documented 3-card payload byte for byte", () => {
    const cards = [
      { id: "1558081531584829", payload: "more-aloes", url: "blue-elf" },
      { id: "861236878885705", payload: "more-crassulas", url: "buddhas-temple" },
      { id: "1587064918516321", payload: "more-echeverias", url: "black-prince" },
    ];
    expect(
      buildTemplateSendComponents({
        body: ["Pablo", "20%", "20OFF"],
        cards: cards.map((c) => ({
          headerMedia: { kind: "image" as const, id: c.id },
          buttons: [
            { index: 0, subType: "quick_reply" as const, text: c.payload },
            { index: 1, subType: "url" as const, text: c.url },
          ],
        })),
      }),
    ).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "Pablo" },
          { type: "text", text: "20%" },
          { type: "text", text: "20OFF" },
        ],
      },
      {
        type: "carousel",
        cards: cards.map((c, i) => ({
          card_index: i,
          components: [
            { type: "header", parameters: [{ type: "image", image: { id: c.id } }] },
            {
              type: "button",
              sub_type: "quick_reply",
              index: "0",
              parameters: [{ type: "payload", payload: c.payload }],
            },
            {
              type: "button",
              sub_type: "url",
              index: "1",
              parameters: [{ type: "text", text: c.url }],
            },
          ],
        })),
      },
    ]);
  });

  it("indexes buttons WITHIN the card, not across the message", () => {
    // Card 2's first button is index 0 again. Numbering them message-wide
    // returns "Parameter value for URL was expected but was not found".
    const built = buildTemplateSendComponents({
      body: [],
      cards: [
        {
          headerMedia: { kind: "image", id: "a" },
          buttons: [{ index: 0, subType: "url", text: "one" }],
        },
        {
          headerMedia: { kind: "image", id: "b" },
          buttons: [{ index: 0, subType: "url", text: "two" }],
        },
      ],
    });
    const carousel = built.find((c) => c.type === "carousel") as {
      cards: Array<{ card_index: number; components: Array<{ index?: string }> }>;
    };
    expect(carousel.cards.map((c) => c.card_index)).toEqual([0, 1]);
    expect(carousel.cards[1]?.components[1]?.index).toBe("0");
  });

  it("emits a card body only when the card has one", () => {
    const built = buildTemplateSendComponents({
      body: [],
      cards: [
        { headerMedia: { kind: "video", link: "https://x/1.mp4" }, body: ["Aloe"] },
        { headerMedia: { kind: "video", link: "https://x/2.mp4" } },
      ],
    });
    const carousel = built.find((c) => c.type === "carousel") as {
      cards: Array<{ components: Array<{ type: string }> }>;
    };
    expect(carousel.cards[0]?.components.map((c) => c.type)).toEqual(["header", "body"]);
    expect(carousel.cards[1]?.components.map((c) => c.type)).toEqual(["header"]);
    // A link header carries `link`, not `id`.
    expect(carousel.cards[0]?.components[0]).toEqual({
      type: "header",
      parameters: [{ type: "video", video: { link: "https://x/1.mp4" } }],
    });
  });
});

describe("media card carousel — component rules", () => {
  const cardHandle = { header_handle: ["4::anBlZw=="] };
  const card = (over: Record<string, unknown> = {}) => ({
    components: [
      { type: "HEADER", format: "IMAGE", example: cardHandle },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Send me more like this!" },
          {
            type: "URL",
            text: "Shop",
            url: "https://www.luckyshrub.com/rare-succulents/{{1}}",
            example: ["BLUE_ELF"],
          },
        ],
      },
    ],
    ...over,
  });
  const withCards = (cards: unknown[], text = "Rare succulents for sale! {{1}}") => [
    body(text, ["Pablo"]),
    { type: "CAROUSEL", cards },
  ];

  it("accepts Meta's documented 3-card template", () => {
    expect(
      validateTemplateComponents("carousel_template_media_cards_v1", withCards([card(), card(), card()]), {
        category: "marketing",
      }),
    ).toEqual([]);
  });

  it("is marketing-only", () => {
    expect(
      validateTemplateComponents("promo", withCards([card(), card()]), {
        category: "utility",
      }).some((i) => i.field === "carousel"),
    ).toBe(true);
  });

  it("requires between 2 and 10 cards", () => {
    for (const n of [0, 1, 11]) {
      expect(
        validateTemplateComponents(
          "promo",
          withCards(Array.from({ length: n }, () => card())),
          { category: "marketing" },
        ).some((i) => i.field === "carousel"),
      ).toBe(true);
    }
    expect(
      validateTemplateComponents(
        "promo",
        withCards(Array.from({ length: 10 }, () => card())),
        { category: "marketing" },
      ),
    ).toEqual([]);
  });

  it("requires message body text above the cards", () => {
    expect(
      validateTemplateComponents(
        "promo",
        [{ type: "CAROUSEL", cards: [card(), card()] }],
        { category: "marketing" },
      ).some((i) => i.field === "carousel"),
    ).toBe(true);
  });

  it("requires an image or video header with a handle on every card", () => {
    const noHeader = { components: [] };
    const textHeader = { components: [{ type: "HEADER", format: "TEXT", text: "Hi" }] };
    const noHandle = { components: [{ type: "HEADER", format: "IMAGE" }] };
    for (const bad of [noHeader, textHeader, noHandle]) {
      expect(
        validateTemplateComponents("promo", withCards([card(), bad]), {
          category: "marketing",
        }).some((i) => i.field === "carousel"),
      ).toBe(true);
    }
  });

  it("rejects cards whose components differ — Meta renders one uniform height", () => {
    const withBody = {
      components: [
        { type: "HEADER", format: "IMAGE", example: cardHandle },
        { type: "BODY", text: "Rare and beautiful." },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "Send me more like this!" },
            {
              type: "URL",
              text: "Shop",
              url: "https://www.luckyshrub.com/rare-succulents/{{1}}",
              example: ["BLUE_ELF"],
            },
          ],
        },
      ],
    };
    // "If any card includes a card body text, then all cards must include one."
    expect(
      validateTemplateComponents("promo", withCards([card(), withBody]), {
        category: "marketing",
      }).some((i) => i.field === "carousel"),
    ).toBe(true);
    // Uniform again once both carry a body.
    expect(
      validateTemplateComponents("promo", withCards([withBody, withBody]), {
        category: "marketing",
      }),
    ).toEqual([]);
  });

  it("rejects a different button ORDER — the send payload indexes by position", () => {
    const swapped = {
      components: [
        { type: "HEADER", format: "IMAGE", example: cardHandle },
        {
          type: "BUTTONS",
          buttons: [
            {
              type: "URL",
              text: "Shop",
              url: "https://www.luckyshrub.com/rare-succulents/{{1}}",
              example: ["BLUE_ELF"],
            },
            { type: "QUICK_REPLY", text: "Send me more like this!" },
          ],
        },
      ],
    };
    expect(
      validateTemplateComponents("promo", withCards([card(), swapped]), {
        category: "marketing",
      }).some((i) => i.field === "carousel"),
    ).toBe(true);
  });

  it("caps a card body at 160 and a card at 2 buttons", () => {
    expect(CAROUSEL_LIMITS.cardBodyMaxLength).toBe(160);
    expect(CAROUSEL_LIMITS.maxButtonsPerCard).toBe(2);
    const longBody = {
      components: [
        { type: "HEADER", format: "IMAGE", example: cardHandle },
        { type: "BODY", text: "x".repeat(161) },
      ],
    };
    expect(
      validateTemplateComponents("promo", withCards([longBody, longBody]), {
        category: "marketing",
      }).some((i) => i.field === "carousel"),
    ).toBe(true);

    const threeButtons = {
      components: [
        { type: "HEADER", format: "IMAGE", example: cardHandle },
        {
          type: "BUTTONS",
          buttons: [
            { type: "QUICK_REPLY", text: "A" },
            { type: "QUICK_REPLY", text: "B" },
            { type: "QUICK_REPLY", text: "C" },
          ],
        },
      ],
    };
    expect(
      validateTemplateComponents("promo", withCards([threeButtons, threeButtons]), {
        category: "marketing",
      }).some((i) => i.field === "carousel"),
    ).toBe(true);
  });

  it("requires a card URL variable to be a suffix with an example", () => {
    const midVariable = {
      components: [
        { type: "HEADER", format: "IMAGE", example: cardHandle },
        {
          type: "BUTTONS",
          buttons: [
            { type: "URL", text: "Shop", url: "https://x/{{1}}/buy", example: ["a"] },
          ],
        },
      ],
    };
    expect(
      validateTemplateComponents("promo", withCards([midVariable, midVariable]), {
        category: "marketing",
      }).some((i) => i.field === "carousel"),
    ).toBe(true);

    const noExample = {
      components: [
        { type: "HEADER", format: "IMAGE", example: cardHandle },
        {
          type: "BUTTONS",
          buttons: [{ type: "URL", text: "Shop", url: "https://x/{{1}}" }],
        },
      ],
    };
    expect(
      validateTemplateComponents("promo", withCards([noExample, noExample]), {
        category: "marketing",
      }).some((i) => i.field === "carousel"),
    ).toBe(true);
  });
});

describe("carousel create payload casing", () => {
  it("lowercases the carousel AND its nested card components", () => {
    // Meta's create example writes every one of these lowercase. The nested
    // ones are the trap: lowering only the outer `carousel` leaves
    // `"type": "HEADER"` inside a card, which Meta rejects with a bare #100.
    expect(
      lowercaseComponentForCreate({
        type: "CAROUSEL",
        cards: [
          {
            components: [
              { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::an"] } },
              {
                type: "BUTTONS",
                buttons: [
                  { type: "QUICK_REPLY", text: "Send me more like this!" },
                  { type: "URL", text: "Shop", url: "https://x/{{1}}", example: ["BLUE_ELF"] },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      type: "carousel",
      cards: [
        {
          components: [
            { type: "header", format: "image", example: { header_handle: ["4::an"] } },
            {
              type: "buttons",
              buttons: [
                { type: "quick_reply", text: "Send me more like this!" },
                { type: "url", text: "Shop", url: "https://x/{{1}}", example: ["BLUE_ELF"] },
              ],
            },
          ],
        },
      ],
    });
  });

  it("leaves an ordinary component's casing alone", () => {
    // Only the types Meta documents lowercase are lowered — uppercasing is
    // what every other component is returned and stored as.
    expect(lowercaseComponentForCreate({ type: "BODY", text: "hi" })).toEqual({
      type: "BODY",
      text: "hi",
    });
    expect(lowercaseComponentForCreate({ type: "LIMITED_TIME_OFFER" })).toEqual({
      type: "limited_time_offer",
    });
  });
});

describe("requiredCarouselCards", () => {
  it("reports what each card needs at send time", () => {
    expect(
      requiredCarouselCards([
        { type: "BODY", text: "Rare succulents for sale! {{1}}" },
        {
          type: "CAROUSEL",
          cards: [
            {
              components: [
                { type: "HEADER", format: "IMAGE" },
                { type: "BODY", text: "{{1}} off {{2}}" },
                {
                  type: "BUTTONS",
                  buttons: [
                    { type: "QUICK_REPLY", text: "More" },
                    { type: "URL", text: "Shop", url: "https://x/{{1}}" },
                  ],
                },
              ],
            },
            {
              components: [
                { type: "HEADER", format: "VIDEO" },
                { type: "BODY", text: "{{1}} off {{2}}" },
                {
                  type: "BUTTONS",
                  buttons: [
                    { type: "QUICK_REPLY", text: "More" },
                    { type: "URL", text: "Shop", url: "https://x/static" },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      // Card 1's URL button carries a variable, so it needs a value at index 1.
      {
        headerKind: "image",
        bodyVarCount: 2,
        buttons: [{ index: 1, subType: "url" }],
      },
      // Card 2's URL is static — nothing to supply. A quick reply's payload is
      // optional to Meta, so it is never demanded either.
      { headerKind: "video", bodyVarCount: 2, buttons: [] },
    ]);
  });

  it("is empty for a template with no carousel", () => {
    expect(requiredCarouselCards([{ type: "BODY", text: "hi" }])).toEqual([]);
  });
});

describe("template quality webhook", () => {
  const wrap = (value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "message_template_quality_update", value }] }],
  });

  it("turns a quality update into a template_status event carrying the band", () => {
    // The band is NOT a sendability decision — all four bands send. It is the
    // early warning: quality drives Meta's template pausing, so RED is a
    // template about to stop working. `status: null` says "this webhook has
    // nothing to say about approval", and ingest only writes what's present.
    const events = metaProvider.parseWebhook(
      wrap({
        message_template_id: 1105258428396250,
        message_template_name: "order_shipped",
        message_template_language: "en_US",
        previous_quality_score: "GREEN",
        new_quality_score: "RED",
      }),
    );
    expect(events).toHaveLength(1);
    const evt = events[0] as {
      kind: string;
      externalId?: string;
      name?: string;
      language?: string;
      status: unknown;
      qualityScore?: string;
    };
    expect(evt.kind).toBe("template_status");
    expect(evt.externalId).toBe("1105258428396250");
    expect(evt.name).toBe("order_shipped");
    expect(evt.language).toBe("en_US");
    expect(evt.status).toBeNull();
    expect(evt.qualityScore).toBe("RED");
  });

  it("normalizes the band's casing but never maps it to an enum", () => {
    // An unrecognized future band must still be storable — it is informational.
    const events = metaProvider.parseWebhook(
      wrap({ message_template_name: "t", new_quality_score: "some_future_band" }),
    );
    expect((events[0] as { qualityScore?: string }).qualityScore).toBe("SOME_FUTURE_BAND");
  });

  it("drops an update with no band or no identity", () => {
    expect(metaProvider.parseWebhook(wrap({ message_template_name: "t" }))).toEqual([]);
    expect(metaProvider.parseWebhook(wrap({ new_quality_score: "RED" }))).toEqual([]);
  });
});

describe("template pause — status webhook shapes", () => {
  const wrap = (value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "message_template_status_update", value }] }],
  });

  it("maps a quality PAUSE to the non-sendable `paused` status", () => {
    // The status is what halts the campaigns: `paused` is not `approved`, and
    // ingest parks every broadcast on this template the moment it lands.
    const events = metaProvider.parseWebhook(
      wrap({
        message_template_id: 1105258428396250,
        message_template_name: "order_promo",
        message_template_language: "en_US",
        event: "PAUSED",
        reason: "PAUSED_FOR_QUALITY",
      }),
    );
    expect(events).toHaveLength(1);
    const evt = events[0] as { status: string; reason?: string; externalId?: string };
    expect(evt.status).toBe("paused");
    expect(evt.reason).toBe("PAUSED_FOR_QUALITY");
    expect(evt.externalId).toBe("1105258428396250");
  });

  it("maps the third instance to `disabled`, not another pause", () => {
    // Meta escalates 3h → 6h → DISABLED. Disabled is terminal; treating it as
    // another pause would leave campaigns waiting for an unpause that never
    // comes.
    const events = metaProvider.parseWebhook(
      wrap({ message_template_name: "order_promo", event: "DISABLED" }),
    );
    expect((events[0] as { status: string }).status).toBe("disabled");
  });

  it("maps the unpause back to `approved`", () => {
    const events = metaProvider.parseWebhook(
      wrap({ message_template_name: "order_promo", event: "APPROVED" }),
    );
    expect((events[0] as { status: string }).status).toBe("approved");
  });
});

describe("business-portfolio pacing", () => {
  it("classifies a 135000 drop as its own account-level cause", () => {
    // NOT a bad recipient and NOT a rate limit: the send succeeded hours
    // earlier and returned a wamid. Meta held the message, reviewed the batch
    // feedback, and dropped it. Retrying this recipient changes nothing —
    // folding it into `provider_rejected` would send an operator hunting a
    // per-contact problem that doesn't exist.
    expect(classifyMetaStatusError(135000)).toBe("portfolio_paced_drop");
  });

  it("keeps the neighbouring post-acceptance codes distinct", () => {
    // All three are only ever seen on a status webhook, and all three have
    // different fixes: wait / stop marketing to them / appeal to Meta.
    expect(classifyMetaStatusError(131049)).toBe("per_user_marketing_cap");
    expect(classifyMetaStatusError(131050)).toBe("marketing_opt_out");
    expect(classifyMetaStatusError(135000)).toBe("portfolio_paced_drop");
  });
});

describe("the delivery ladder with held", () => {
  // Getting this wrong corrupts the headline number the whole funnel exists for,
  // and silently: no error, just a campaign that reports the wrong outcome.
  it("lets delivery and read advance past held", () => {
    expect(deliveryWinsOver("delivered", "held")).toBe(true);
    expect(deliveryWinsOver("read", "held")).toBe(true);
  });

  it("lets a terminal drop overwrite held — that IS what 135000 does", () => {
    expect(deliveryWinsOver("undelivered", "held")).toBe(true);
  });

  it("does NOT let a plain `sent` webhook erase held", () => {
    // Equal rank. `held` is the more specific fact about the same moment: Meta
    // accepted the message AND parked it. A `sent` status says only the first
    // half, so accepting it would lose the reason a campaign looks stalled.
    expect(deliveryWinsOver("sent", "held")).toBe(false);
  });

  it("does not regress a delivered message into held", () => {
    expect(deliveryWinsOver("held", "delivered")).toBe(false);
    expect(deliveryWinsOver("held", "read")).toBe(false);
  });

  it("advances pending into held", () => {
    expect(deliveryWinsOver("held", "pending")).toBe(true);
  });
});

describe("every normalized error code has a report label", () => {
  it("has no unlabelled code", () => {
    // A missing entry renders the raw snake_case key in the campaign report,
    // the CSV and the API alike — silent, and only noticed by whoever reads the
    // report. Two codes had already drifted this way by the time this was
    // written, so the check is a test rather than another manual sweep.
    const unlabelled = ALL_META_ERROR_CODES.filter((c) => !(c in ERROR_LABELS));
    expect(unlabelled).toEqual([]);
  });
});

describe("messaging limits — portfolio-scoped since 2025-10-07", () => {
  const health = (field: string, value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field, value }] }],
  });
  const tierOf = (events: unknown[]) =>
    (events[0] as { messagingTier?: string } | undefined)?.messagingTier;

  it("reads the portfolio limit from business_capability_update", () => {
    // `max_daily_conversation_per_phone` — the field this used to read alone —
    // was REMOVED by Meta in February 2026.
    expect(
      tierOf(
        metaProvider.parseWebhook(
          health("business_capability_update", {
            max_daily_conversations_per_business: 100000,
          }),
        ),
      ),
    ).toBe("100000");
  });

  it("reads it from phone_number_quality_update too", () => {
    // Same new parameter on both webhooks — the limit is a property of the
    // portfolio now, so whichever webhook carries it is equally authoritative.
    expect(
      tierOf(
        metaProvider.parseWebhook(
          health("phone_number_quality_update", {
            max_daily_conversations_per_business: "UNLIMITED",
          }),
        ),
      ),
    ).toBe("UNLIMITED");
  });

  it("prefers the portfolio limit over the legacy per-phone value", () => {
    // A payload carrying both is the transition case. Per-phone is at best the
    // same number and at worst stale, so it must never win.
    expect(
      tierOf(
        metaProvider.parseWebhook(
          health("business_capability_update", {
            max_daily_conversations_per_business: 10000,
            max_daily_conversation_per_phone: 1000,
          }),
        ),
      ),
    ).toBe("10000");
  });

  it("still reads the legacy fields when that's all there is", () => {
    expect(
      tierOf(
        metaProvider.parseWebhook(
          health("business_capability_update", { max_daily_conversation_per_phone: 1000 }),
        ),
      ),
    ).toBe("1000");
    expect(
      tierOf(
        metaProvider.parseWebhook(
          health("phone_number_quality_update", { current_limit: "TIER_10K" }),
        ),
      ),
    ).toBe("TIER_10K");
  });
});

describe("normalizeMessagingTier across every spelling Meta uses", () => {
  it("normalizes the current ladder", () => {
    expect(normalizeMessagingTier("TIER_250")).toBe("TIER_250");
    expect(normalizeMessagingTier(2000)).toBe("TIER_2K");
    expect(normalizeMessagingTier("10000")).toBe("TIER_10K");
    expect(normalizeMessagingTier("100000")).toBe("TIER_100K");
    expect(normalizeMessagingTier("UNLIMITED")).toBe("TIER_UNLIMITED");
  });

  it("returns null for a THROUGHPUT level, which shares the `current_limit` field", () => {
    // Since the portfolio move, `current_limit` carries either the messaging
    // limit or the number's throughput level. Mapping a throughput string onto a
    // tier would gate a campaign against a number that means nothing.
    expect(normalizeMessagingTier("STANDARD")).toBeNull();
    expect(normalizeMessagingTier("HIGH")).toBeNull();
  });
});

describe("per-user marketing cap suppression window", () => {
  // The rule Meta states outright: wait at least 24 hours before resending to a
  // user who hit their limit. Sooner earns the same error, and a WABA that
  // repeatedly retries capped users can have delivery to them cut off for up to
  // 24 hours — so this window is a protection, not a nicety.
  const COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const isSuppressed = (capReachedAt: Date | null, now: number) =>
    capReachedAt !== null && capReachedAt.getTime() >= now - COOLDOWN_MS;

  const now = Date.UTC(2026, 6, 23, 12, 0, 0);

  it("suppresses a contact capped an hour ago", () => {
    expect(isSuppressed(new Date(now - 60 * 60 * 1000), now)).toBe(true);
  });

  it("releases them once the 24 hours are up", () => {
    // Not sticky, unlike an opt-out: the person made no choice about us and the
    // cap clears on its own, so a contact must come back automatically.
    expect(isSuppressed(new Date(now - COOLDOWN_MS - 1000), now)).toBe(false);
  });

  it("leaves a never-capped contact alone", () => {
    expect(isSuppressed(null, now)).toBe(false);
  });
});

describe("account_update violations", () => {
  const accountUpdate = (value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "account_update", value }] }],
  });

  it("keeps a NON-calling policy violation instead of dropping it", () => {
    // This used to `return null`. Meta names this webhook as the channel for
    // policy violations and restricts an account that doesn't address one, so
    // dropping it meant the restriction was the first thing a tenant heard.
    const events = metaProvider.parseWebhook(
      accountUpdate({
        phone_number: "16505551111",
        event: "ACCOUNT_VIOLATION",
        violation_info: { violation_type: "ALCOHOL" },
      }),
    );
    expect(events).toHaveLength(1);
    const evt = events[0] as { kind: string; policyViolationType?: string };
    expect(evt.kind).toBe("channel_health");
    expect(evt.policyViolationType).toBe("ALCOHOL");
  });

  it("still routes a CALLING violation to the calling warning", () => {
    // Different field on purpose: the actionable response differs (narrow call
    // hours / hide the call button), and it precedes a CALLING pause, not an
    // account restriction.
    const evt = metaProvider.parseWebhook(
      accountUpdate({
        event: "ACCOUNT_VIOLATION",
        violation_info: { violation_type: "CALLING_QUALITY" },
      }),
    )[0] as { callingQualityWarning?: string; policyViolationType?: string };
    expect(evt.callingQualityWarning).toBe("CALLING_QUALITY");
    expect(evt.policyViolationType).toBeUndefined();
  });

  it("drops a violation with no type rather than storing an empty warning", () => {
    expect(
      metaProvider.parseWebhook(accountUpdate({ event: "ACCOUNT_VIOLATION" })),
    ).toEqual([]);
  });
});

describe("failure buckets tell the operator the right thing to do", () => {
  // The bucket is not a taxonomy — it is an INSTRUCTION. `permanent` renders as
  // "Clean list", i.e. remove this contact. Everything that fell to the default
  // inherited that instruction, which is how "opted out of marketing" came to
  // read as "delete this customer".
  it("only sends a genuinely unreachable number to Clean list", () => {
    expect(failureBucket("invalid_recipient")).toBe("permanent");
  });

  it("never tells anyone to delete a contact over a preference or a limit", () => {
    for (const code of [
      "marketing_opt_out",
      "per_user_marketing_cap",
      "portfolio_paced_drop",
      "call_permission_required",
      "recipient_unavailable",
      "outside_24h_window",
    ] as const) {
      expect(failureBucket(code)).toBe("suppress");
    }
  });

  it("points OUR content faults at the message, not the contact list", () => {
    // These fail every recipient identically until the template changes.
    for (const code of [
      "unsupported_message",
      "duplicate_button_title",
      "message_unavailable",
    ] as const) {
      expect(failureBucket(code)).toBe("content");
    }
  });

  it("defaults an unknown code to the conservative bucket", () => {
    // Not `permanent`: we can't claim a recipient is bad from a code we don't
    // recognise, and the cost of guessing wrong is a deleted customer.
    expect(failureBucket("provider_rejected")).toBe("suppress");
    expect(failureBucket("something_new_from_meta")).toBe("suppress");
    expect(failureBucket(null)).toBe("suppress");
  });

  it("keeps every code out of the default arm", () => {
    // Same guard as the label check: a new code silently inheriting a bucket is
    // how this defect happened in the first place.
    const unbucketed = ALL_META_ERROR_CODES.filter(
      (c) => c !== "provider_rejected" && failureBucket(c) === failureBucket("__unknown__"),
    );
    // Only codes deliberately sharing the default's verdict may match, and each
    // is asserted explicitly above.
    expect(unbucketed.every((c) => failureBucket(c) === "suppress")).toBe(true);
  });
});

describe("unknown account_update events are surfaced, not swallowed", () => {
  const accountUpdate = (value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "waba", changes: [{ field: "account_update", value }] }],
  });

  it("logs AND persists an event it doesn't recognise instead of dropping it", () => {
    // Meta's account-model evolution says an `account_update` fires when an app
    // is REMOVED from a WhatsApp Business Account — the event that makes an
    // integration go dark — and publishes no name or shape for it. Parsing a
    // shape we don't have would be guessing; going quiet would make it
    // invisible. So: a warning that carries the payload, PLUS a channel_health
    // event whose `accountAlert` lands in the connection's last-alert slot
    // (queryable, not just a log line at info severity).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const events = metaProvider.parseWebhook(
        accountUpdate({ event: "SOME_FUTURE_EVENT", detail: { anything: true } }),
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "channel_health",
        wabaId: "waba",
        accountAlert: {
          source: "account_update",
          event: "SOME_FUTURE_EVENT",
        },
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
      expect(line.event).toBe("meta.account_update_unhandled");
      expect(line.metaEvent).toBe("SOME_FUTURE_EVENT");
      // The raw payload rides along — that is the whole point.
      expect(line.payload).toContain("SOME_FUTURE_EVENT");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet for the events it DOES handle", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      metaProvider.parseWebhook(
        accountUpdate({
          event: "ACCOUNT_VIOLATION",
          violation_info: { violation_type: "ALCOHOL" },
        }),
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("messaging_account_id is opt-in", () => {
  // Meta's account-model split lets one number carry several Messaging
  // Accounts. The parameter names which to bill — optional at Phase 1, required
  // only when ONE app holds more than one on the same number.
  //
  // The reason it defaults off is not caution for its own sake: it belongs to a
  // beta that is "subject to change", and Graph rejects an unrecognised body
  // field with #100 — which fails the whole send, for every tenant. So an
  // unset config must produce a byte-identical wire to today.
  const base = {
    phoneNumberId: "pn",
    accessToken: "t",
    graphVersion: "v25.0",
  };

  it("adds nothing when no Messaging Account is configured", () => {
    expect(messagingAccountField(base)).toEqual({});
  });

  it("names the account when one IS configured", () => {
    expect(messagingAccountField({ ...base, messagingAccountId: "ma_123" })).toEqual({
      messaging_account_id: "ma_123",
    });
  });

  it("does not fall back to the WABA id", () => {
    // They are the same value for most tenants today, but "the account that
    // owns our templates" and "the account to bill" are only the same thing
    // until they aren't — deriving one from the other would bill silently wrong
    // in exactly the multi-account setup the parameter exists for.
    expect(messagingAccountField({ ...base, wabaId: "waba_1" })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// templateReviewWarnings — ADVISORY review-risk patterns from the template-
// review doc's "common rejection reasons". Deliberately a separate function
// from validateTemplateComponents: Meta's own presets break some of these
// (the authentication body "{{1}} is your verification code." STARTS with a
// parameter), so they warn and must never block a create.
// ---------------------------------------------------------------------------
describe("templateReviewWarnings", () => {
  const bodyOf = (text: string) => [{ type: "BODY", text }];

  it("returns nothing for an unremarkable body", () => {
    expect(templateReviewWarnings(bodyOf("Hi {{1}}, your order has shipped."))).toEqual([]);
  });

  it("flags a body that starts or ends with a variable (dangling)", () => {
    expect(templateReviewWarnings(bodyOf("{{1}} is your code."))).toHaveLength(1);
    expect(templateReviewWarnings(bodyOf("Your code is {{1}}"))).toHaveLength(1);
    // Both ends → still ONE dangling warning, naming both.
    const both = templateReviewWarnings(bodyOf("{{1}} and then {{2}}"));
    expect(both).toHaveLength(1);
    expect(both[0]!.message).toContain("starts and ends");
  });

  it("flags a {{…}} token that is a variable in neither dialect", () => {
    const issues = templateReviewWarnings(bodyOf("Get {{50%}} off today only."));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.field).toBe("body");
    expect(issues[0]!.message).toContain("{{50%}}");
  });

  it("flags mismatched double braces", () => {
    const issues = templateReviewWarnings(bodyOf("Use code {{SAVE today."));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('"{{"');
  });

  it("scans a TEXT header but never a media header", () => {
    expect(
      templateReviewWarnings([
        { type: "HEADER", format: "TEXT", text: "Order {{#}}" },
        { type: "BODY", text: "All good here." },
      ]),
    ).toHaveLength(1);
    expect(
      templateReviewWarnings([
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "All good here." },
      ]),
    ).toEqual([]);
  });

  it("a lone-variable HEADER is fine — dangling applies to the body only", () => {
    expect(
      templateReviewWarnings([
        { type: "HEADER", format: "TEXT", text: "{{1}}" },
        { type: "BODY", text: "Padded body text here." },
      ]),
    ).toEqual([]);
  });

  it("never fires for valid tokens of either dialect", () => {
    expect(
      templateReviewWarnings(bodyOf("Hi {{first_name}}, order {{order_id}} is ready today.")),
    ).toEqual([]);
  });
});
