/**
 * What a template send put on the customer's screen, captured onto the message
 * (lib/templates/sent-snapshot) — so the agent's thread shows the header image,
 * body, footer AND buttons, instead of one line of body text.
 *
 * Reported from prod: WhatsApp showed "developers.facebook.com" (the footer) and
 * a "Get free delivery" button (a URL button); the inbox showed neither.
 *
 * The properties that carry the risk:
 *
 *   1. **A URL button carries the RESOLVED link** — base + the dynamic suffix the
 *      send actually used, positional or named — because that is what the
 *      customer taps.
 *   2. **An OTP code is never stored.** It is a login secret; the row outlives it
 *      by months and every agent in the workspace can read it.
 *   3. **Only http(s) becomes a link.** The url turns into an `href` in the
 *      agent's browser.
 *   4. **No footer and no buttons → no snapshot**, so a plain template's row is
 *      byte-for-byte what it was before.
 *   5. **Header media columns obey all three gates** — the workspace's own key
 *      prefix, the stable url, and a known mime — shared by BOTH send paths.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-sent-snapshot.spec.ts
 */
import { describe, expect, it, vi } from "vitest";

const OWN = "https://r2.test.invalid/bucket/";
vi.mock("@/lib/blob-storage", () => ({
  blobStorage: {
    isOwnUrl: (url: string) => url.startsWith(OWN),
    keyFromUrl: (url: string) => (url.startsWith(OWN) ? url.slice(OWN.length) : null),
  },
}));

// Imports AFTER mocks are registered.
import { buildTemplateSentSnapshot, headerMediaColumns } from "@/lib/templates/sent-snapshot";

/** The exact template from the prod report. */
const JASPERS = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "Free delivery for all online orders with Jasper's Market" },
  { type: "FOOTER", text: "developers.facebook.com" },
  {
    type: "BUTTONS",
    buttons: [
      {
        type: "URL",
        text: "Get free delivery",
        url: "https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/utility-templates",
      },
    ],
  },
];

describe("buildTemplateSentSnapshot", () => {
  it("captures the reported template's footer and URL button", () => {
    expect(buildTemplateSentSnapshot(JASPERS, [])).toEqual({
      kind: "template",
      footer: "developers.facebook.com",
      buttons: [
        {
          type: "url",
          text: "Get free delivery",
          url: "https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/utility-templates",
        },
      ],
    });
  });

  it("resolves a dynamic URL suffix — positional and named", () => {
    const withSuffix = (url: string) => [
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Track", url }] },
    ];
    const params = [{ index: 0, subType: "url", text: "A-42" }];
    expect(
      buildTemplateSentSnapshot(withSuffix("https://shop.example/track/{{1}}"), params)?.buttons?.[0]
        ?.url,
    ).toBe("https://shop.example/track/A-42");
    expect(
      buildTemplateSentSnapshot(withSuffix("https://shop.example/o/{{order_id}}"), params)
        ?.buttons?.[0]?.url,
    ).toBe("https://shop.example/o/A-42");
  });

  it("keys a parameter to its OWN button index, not the first URL button", () => {
    const comps = [
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Static", url: "https://a.example/help" },
          { type: "URL", text: "Dynamic", url: "https://a.example/o/{{1}}" },
        ],
      },
    ];
    const snap = buildTemplateSentSnapshot(comps, [{ index: 1, subType: "url", text: "77" }]);
    expect(snap?.buttons?.map((b) => b.url)).toEqual([
      "https://a.example/help",
      "https://a.example/o/77",
    ]);
  });

  it("NEVER stores an OTP code — label only", () => {
    const comps = [
      { type: "BODY", text: "{{1}} is your verification code." },
      { type: "BUTTONS", buttons: [{ type: "OTP", text: "Copy code" }] },
    ];
    const snap = buildTemplateSentSnapshot(comps, [{ index: 0, subType: "url", text: "492837" }]);
    expect(snap?.buttons).toEqual([{ type: "otp", text: "Copy code" }]);
    expect(JSON.stringify(snap)).not.toContain("492837");
  });

  it("keeps a coupon's code, with Meta's label when the component has none", () => {
    const comps = [{ type: "BUTTONS", buttons: [{ type: "COPY_CODE" }] }];
    expect(
      buildTemplateSentSnapshot(comps, [{ index: 0, subType: "copy_code", text: "SPRING25" }])?.buttons,
    ).toEqual([{ type: "copy_code", text: "Copy offer code", code: "SPRING25" }]);
  });

  it("carries a phone button's number and a quick reply's label", () => {
    const comps = [
      {
        type: "BUTTONS",
        buttons: [
          { type: "PHONE_NUMBER", text: "Call us", phone_number: "+15550100" },
          { type: "QUICK_REPLY", text: "Stop promotions" },
        ],
      },
    ];
    expect(buildTemplateSentSnapshot(comps, [])?.buttons).toEqual([
      { type: "phone", text: "Call us", phone: "+15550100" },
      { type: "quick_reply", text: "Stop promotions" },
    ]);
  });

  it("drops a non-http(s) link — it would become an href", () => {
    const comps = [
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Bad", url: "javascript:alert(1)" }] },
    ];
    expect(buildTemplateSentSnapshot(comps, [])?.buttons).toEqual([{ type: "url", text: "Bad" }]);
  });

  it("returns null for a template with no footer and no buttons", () => {
    expect(buildTemplateSentSnapshot([{ type: "BODY", text: "Hi {{1}}" }], [])).toBeNull();
    expect(buildTemplateSentSnapshot("not-an-array", [])).toBeNull();
    // A blank footer is not a footer.
    expect(buildTemplateSentSnapshot([{ type: "FOOTER", text: "   " }], [])).toBeNull();
  });
});

describe("headerMediaColumns", () => {
  const ws = "ws_mine";
  const link = `${OWN}media/${ws}/2026/09/tpl-hdr-abc-banner.jpg`;

  it("writes every column for our own, in-workspace asset with a known mime", () => {
    expect(
      headerMediaColumns(ws, "image", { link, mimeType: "image/jpeg", sizeBytes: 71121 }),
    ).toEqual({
      mediaKind: "image",
      mediaKey: `media/${ws}/2026/09/tpl-hdr-abc-banner.jpg`,
      mediaUrl: link,
      mediaMimeType: "image/jpeg",
      mediaSizeBytes: 71121,
    });
  });

  it("refuses a SIBLING tenant's object even though the host is ours", () => {
    const foreign = `${OWN}media/ws_other/2026/09/tpl-hdr-abc-banner.jpg`;
    expect(headerMediaColumns(ws, "image", { link: foreign, mimeType: "image/jpeg" })).toEqual({});
  });

  it("writes nothing without a mime — both or neither", () => {
    expect(headerMediaColumns(ws, "image", { link })).toEqual({});
  });

  it("writes nothing for a foreign host, a Meta media id, or a non-media header", () => {
    expect(
      headerMediaColumns(ws, "image", { link: "https://cdn.example/x.jpg", mimeType: "image/jpeg" }),
    ).toEqual({});
    expect(headerMediaColumns(ws, "image", { id: "2871834006348767", mimeType: "image/jpeg" })).toEqual(
      {},
    );
    expect(headerMediaColumns(ws, null, { link, mimeType: "image/jpeg" })).toEqual({});
  });
});
