/**
 * Structured templates + personas — the caps Meta enforces and the two fields
 * that fail SILENTLY when you get them wrong.
 *
 *   pnpm --filter @ccp/api exec vitest run test/messenger-templates-personas.spec.ts
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildTemplatePayload,
  MessengerTemplateError,
  sendMessengerTemplate,
} from "@/lib/providers/messenger-templates";
import { listPersonas, sendPersonaTyping } from "@/lib/providers/messenger-personas";

const target = {
  accountId: "PAGE_1",
  accessToken: "page-tok",
  graphVersion: "v26.0",
  label: "messenger",
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function mockGraph(responses: unknown[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(
        JSON.stringify(responses[Math.min(i++, responses.length - 1)] ?? {}),
        { status: 200 },
      );
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("template payload caps", () => {
  it("rejects more than 3 buttons", () => {
    expect(() =>
      buildTemplatePayload({
        kind: "button",
        text: "Pick",
        buttons: Array.from({ length: 4 }, (_, i) => ({
          type: "postback" as const,
          title: `B${i}`,
          payload: `P${i}`,
        })),
      }),
    ).toThrow(MessengerTemplateError);
  });

  it("rejects more than 10 generic cards", () => {
    expect(() =>
      buildTemplatePayload({
        kind: "generic",
        elements: Array.from({ length: 11 }, (_, i) => ({ title: `Card ${i}` })),
      }),
    ).toThrow(MessengerTemplateError);
  });

  it("rejects a call button that isn't E.164", () => {
    // Meta accepts a bare national number on the wire and it then fails to DIAL
    // on the recipient's phone — a silent break that a 400 here prevents.
    expect(() =>
      buildTemplatePayload({
        kind: "button",
        text: "Call us",
        buttons: [{ type: "phone_number", title: "Call", payload: "6505551234" }],
      }),
    ).toThrow(/E\.164/);
  });

  it("truncates over-long titles rather than failing the send", () => {
    const payload = buildTemplatePayload({
      kind: "generic",
      elements: [{ title: "x".repeat(200), subtitle: "y".repeat(200) }],
    }) as { elements: Array<{ title: string; subtitle: string }> };
    // A display limit is not a malformed request: losing the tail beats losing
    // the agent's whole message.
    expect(payload.elements[0]!.title).toHaveLength(80);
    expect(payload.elements[0]!.subtitle).toHaveLength(80);
  });

  it("omits fallback_url unless messenger_extensions is on", () => {
    // Meta: "may only be specified if messenger_extensions is true" — sending it
    // otherwise is a rejection.
    const payload = buildTemplatePayload({
      kind: "button",
      text: "Open",
      buttons: [
        { type: "web_url", title: "Go", url: "https://x.test", fallbackUrl: "https://f.test" },
      ],
    }) as { buttons: Array<Record<string, unknown>> };
    expect(payload.buttons[0]).not.toHaveProperty("fallback_url");
  });

  it("maps default_action as a URL button WITHOUT a title", () => {
    const payload = buildTemplatePayload({
      kind: "generic",
      elements: [{ title: "Card", defaultActionUrl: "https://x.test" }],
    }) as { elements: Array<{ default_action: Record<string, unknown> }> };
    // Meta: "the same properties as URL button, except `title`".
    expect(payload.elements[0]!.default_action).toEqual({
      type: "web_url",
      url: "https://x.test",
    });
  });
});

describe("persona_id is a TOP-LEVEL send field", () => {
  it("sits beside `message`, never inside it", async () => {
    const calls = mockGraph([{ message_id: "m_1" }]);
    await sendMessengerTemplate(
      {
        to: "PSID_1",
        personaId: "PERSONA_1",
        template: { kind: "button", text: "Hi", buttons: [{ type: "postback", title: "Ok", payload: "OK" }] },
      },
      target,
      { messaging_type: "RESPONSE" },
    );
    const body = calls[0]!.body!;
    // Nested inside `message` it is SILENTLY ignored: the send succeeds, returns
    // a message id, and goes out as the Page with nothing to notice.
    expect(body.persona_id).toBe("PERSONA_1");
    expect(body.message).not.toHaveProperty("persona_id");
  });

  it("carries a persona on typing, the only sender action that takes one", async () => {
    const calls = mockGraph([{}]);
    await sendPersonaTyping({ to: "PSID_1", personaId: "PERSONA_1", active: true }, target);
    expect(calls[0]!.body).toEqual({
      recipient: { id: "PSID_1" },
      sender_action: "typing_on",
      persona_id: "PERSONA_1",
    });
  });
});

describe("listPersonas paging", () => {
  it("stops at the last page instead of re-requesting it forever", async () => {
    // `cursors.after` is present on the FINAL page too. Following it without
    // checking `paging.next` re-requests that page until the loop cap.
    const calls = mockGraph([
      {
        data: [{ id: "P1", name: "Adam" }],
        paging: { cursors: { after: "CUR" } },
      },
    ]);
    const personas = await listPersonas(target);
    expect(calls).toHaveLength(1);
    expect(personas).toEqual([{ id: "P1", name: "Adam", profilePictureUrl: null }]);
  });

  it("follows paging.next across pages", async () => {
    const calls = mockGraph([
      {
        data: [{ id: "P1", name: "Adam" }],
        paging: { cursors: { after: "CUR" }, next: "https://graph.test/next" },
      },
      { data: [{ id: "P2", name: "David" }], paging: { cursors: {} } },
    ]);
    const personas = await listPersonas(target);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain("after=CUR");
    expect(personas.map((p) => p.id)).toEqual(["P1", "P2"]);
  });
});

describe("media template", () => {
  it("refuses an external URL and names the actual remedy", () => {
    // Meta: "the media template does not allow any external URL". An external
    // one is ACCEPTED by the request and then renders as a broken card, so the
    // error has to arrive here and has to say "upload it first".
    expect(() =>
      buildTemplatePayload({
        kind: "media",
        mediaType: "image",
        url: "https://example.com/cat.jpg",
      }),
    ).toThrow(/Attachment Upload API/);
  });

  it("accepts a Facebook-hosted URL", () => {
    const payload = buildTemplatePayload({
      kind: "media",
      mediaType: "video",
      url: "https://scontent.xx.fbcdn.net/v/clip.mp4",
    }) as { elements: Array<Record<string, unknown>> };
    expect(payload.elements[0]).toMatchObject({
      media_type: "video",
      url: "https://scontent.xx.fbcdn.net/v/clip.mp4",
    });
  });

  it("requires exactly one of attachmentId or url", () => {
    // Meta documents each as "cannot be used if the other is set", so BOTH and
    // NEITHER are equally wrong.
    expect(() =>
      buildTemplatePayload({
        kind: "media",
        mediaType: "image",
        attachmentId: "1",
        url: "https://scontent.xx.fbcdn.net/a.jpg",
      }),
    ).toThrow(MessengerTemplateError);
    expect(() => buildTemplatePayload({ kind: "media", mediaType: "image" })).toThrow(
      MessengerTemplateError,
    );
  });
});

describe("image grid template", () => {
  const img = (n: number) => ({ url: `https://x.test/${n}.jpg` });

  it("enforces 2-6 images", () => {
    expect(() => buildTemplatePayload({ kind: "image_grid", images: [img(1)] })).toThrow(/2-6/);
    expect(() =>
      buildTemplatePayload({ kind: "image_grid", images: [1, 2, 3, 4, 5, 6, 7].map(img) }),
    ).toThrow(/2-6/);
  });

  it("allows at most one hero image", () => {
    // "sending more than one fails with an error" — catching it here beats a
    // Graph rejection the agent can't interpret.
    expect(() =>
      buildTemplatePayload({
        kind: "image_grid",
        images: [
          { ...img(1), isHeroImage: true },
          { ...img(2), isHeroImage: true },
        ],
      }),
    ).toThrow(/hero/);
  });

  it("rejects a phone_number button, which this template alone disallows", () => {
    // Only URL and postback buttons are supported below a grid — the shared
    // button validator accepts phone_number, so the template must catch it.
    expect(() =>
      buildTemplatePayload({
        kind: "image_grid",
        images: [img(1), img(2)],
        buttons: [{ type: "phone_number", title: "Call", payload: "+16505551234" }],
      }),
    ).toThrow(/URL and postback/);
  });

  it("uses the grid's OWN 45-char title cap, not the generic template's 80", () => {
    const payload = buildTemplatePayload({
      kind: "image_grid",
      images: [img(1), img(2)],
      title: "x".repeat(100),
      subtitle: "y".repeat(100),
    }) as { elements: Array<{ title: string; subtitle: string }> };
    expect(payload.elements[0]!.title).toHaveLength(45);
    expect(payload.elements[0]!.subtitle).toHaveLength(80);
  });

  it("maps per-image actions, keeping postback `text`", () => {
    const payload = buildTemplatePayload({
      kind: "image_grid",
      images: [
        { ...img(1), isHeroImage: true, action: { type: "web_url", url: "https://x.test/p" } },
        { ...img(2), action: { type: "postback", payload: "P", text: "Tell me more" } },
      ],
    }) as { elements: Array<{ images: Array<Record<string, unknown>> }> };
    expect(payload.elements[0]!.images[0]).toEqual({
      url: "https://x.test/1.jpg",
      is_hero_image: true,
      action: { type: "web_url", url: "https://x.test/p" },
    });
    // `text` is what Meta posts as the recipient's reply — without it the tap
    // looks like it did nothing.
    expect(payload.elements[0]!.images[1]!.action).toEqual({
      type: "postback",
      payload: "P",
      text: "Tell me more",
    });
  });
});

describe("persona on a plain text send", () => {
  it("is top-level, and is NOT attached to a private reply", async () => {
    const { sendSocialText } = await import("@/lib/providers/meta-social");

    const calls = mockGraph([{ message_id: "m_1" }, { message_id: "m_2" }]);

    await sendSocialText({ to: "PSID_1", body: "hi", personaId: "PERSONA_1" }, target);
    expect(calls[0]!.body!.persona_id).toBe("PERSONA_1");
    expect(calls[0]!.body!.message).not.toHaveProperty("persona_id");

    // A private reply is the message that STARTS a conversation, addressed at a
    // comment rather than a person. A persona is a voice inside one, so the
    // field is deliberately absent there — along with every other
    // window-related field on that branch.
    await sendSocialText(
      { to: "PSID_1", body: "hi", personaId: "PERSONA_1", privateReplyToCommentId: "C_1" },
      target,
    );
    expect(calls[1]!.body).not.toHaveProperty("persona_id");
  });
});

describe("receipt template", () => {
  const base = {
    kind: "receipt" as const,
    recipientName: "Ada Lovelace",
    orderNumber: "ORD-1",
    currency: "USD",
    paymentMethod: "Visa 1234",
    summary: { totalCost: 42.5 },
  };

  it("converts the order time to SECONDS, as a string", () => {
    const payload = buildTemplatePayload({
      ...base,
      orderedAt: new Date("2026-07-30T12:00:00.000Z"),
    }) as { timestamp: string };
    // Milliseconds here renders a date ~50,000 years out — accepted by the API
    // and obviously wrong only to the customer.
    expect(payload.timestamp).toBe(String(Math.floor(Date.parse("2026-07-30T12:00:00Z") / 1000)));
  });

  it("requires summary.totalCost", () => {
    expect(() =>
      buildTemplatePayload({ ...base, summary: {} as unknown as { totalCost: number } }),
    ).toThrow(/totalCost/);
  });

  it("caps line items at 100", () => {
    expect(() =>
      buildTemplatePayload({
        ...base,
        elements: Array.from({ length: 101 }, (_, i) => ({ title: `Item ${i}`, price: 1 })),
      }),
    ).toThrow(/100/);
  });

  it("maps the address to Meta's snake_case field names", () => {
    const payload = buildTemplatePayload({
      ...base,
      address: {
        street1: "1 Main St",
        city: "Springfield",
        postalCode: "12345",
        state: "IL",
        country: "US",
      },
    }) as { address: Record<string, unknown> };
    expect(payload.address).toEqual({
      street_1: "1 Main St",
      city: "Springfield",
      postal_code: "12345",
      state: "IL",
      country: "US",
    });
  });
});

describe("coupon template", () => {
  it("requires at least one of couponCode / couponUrl", () => {
    // Meta documents each as "required unless the other is set", so neither is
    // the one combination it rejects.
    expect(() => buildTemplatePayload({ kind: "coupon", title: "10% off" })).toThrow(
      /couponCode.*couponUrl/,
    );
  });

  it("rejects a code containing a space", () => {
    // Meta: "Can not have spaces." A spaced code is accepted and then fails to
    // redeem — which the customer discovers and the business does not.
    expect(() =>
      buildTemplatePayload({ kind: "coupon", title: "10% off", couponCode: "10 PERCENT" }),
    ).toThrow(/spaces/);
  });

  it("builds the full coupon payload", () => {
    const payload = buildTemplatePayload({
      kind: "coupon",
      title: "10% off everything",
      subtitle: "Expires Oct 1",
      couponCode: "10PERCENT",
      couponUrl: "https://shop.test",
      couponUrlButtonTitle: "Shop now",
      couponPreMessage: "A deal for you!",
      payload: "coupon-10",
    });
    expect(payload).toEqual({
      template_type: "coupon",
      title: "10% off everything",
      subtitle: "Expires Oct 1",
      coupon_code: "10PERCENT",
      coupon_url: "https://shop.test",
      coupon_url_button_title: "Shop now",
      coupon_pre_message: "A deal for you!",
      payload: "coupon-10",
    });
  });
});
