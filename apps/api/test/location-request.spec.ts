import { afterEach, describe, expect, it, vi } from "vitest";

import { SendInteractiveSchema } from "@/messages/messages.schemas";
import { ExternalSendInteractiveSchema } from "@/external/v1/external-v1.schemas";
import { metaProvider } from "@/lib/providers/meta";
import { CHANNEL_CAPABILITIES } from "@ccp/shared/providers/capabilities";

/**
 * Location request messages (location-request-messages doc): body text + a
 * WhatsApp-rendered "send location" button. Wire:
 *
 *   interactive: { type: "location_request_message",
 *                  body: { text }, action: { name: "send_location" } }
 *
 * Pinned here: the exact wire shape, and the schema rule — mirrored between
 * the composer schema and /v1 (§12 parity) — that `location_request` carries
 * NO authored options while buttons/list still require them.
 */

describe("schemas (composer + /v1 mirror)", () => {
  const base = { conversationId: "c1", body: "Where should we deliver?" };

  it("accepts location_request with no options on both schemas", () => {
    expect(
      SendInteractiveSchema.safeParse({ ...base, kind: "location_request" }).success,
    ).toBe(true);
    expect(
      ExternalSendInteractiveSchema.safeParse({
        body: base.body,
        kind: "location_request",
      }).success,
    ).toBe(true);
  });

  it("rejects location_request WITH options (WhatsApp renders the button)", () => {
    const withOpts = {
      ...base,
      kind: "location_request",
      options: [{ id: "a", title: "A" }],
    };
    expect(SendInteractiveSchema.safeParse(withOpts).success).toBe(false);
    expect(
      ExternalSendInteractiveSchema.safeParse({
        body: base.body,
        kind: "location_request",
        options: [{ id: "a", title: "A" }],
      }).success,
    ).toBe(false);
  });

  it("still requires ≥1 option for buttons/list on both schemas", () => {
    for (const kind of ["buttons", "list"] as const) {
      expect(SendInteractiveSchema.safeParse({ ...base, kind }).success).toBe(false);
      expect(
        ExternalSendInteractiveSchema.safeParse({ body: base.body, kind }).success,
      ).toBe(false);
    }
  });

  it("is capability-gated to WhatsApp", () => {
    expect(CHANNEL_CAPABILITIES.whatsapp.locationRequest).toBe(true);
    expect(CHANNEL_CAPABILITIES.messenger.locationRequest).toBeUndefined();
    expect(CHANNEL_CAPABILITIES.instagram.locationRequest).toBeUndefined();
  });
});

describe("provider wire shape", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts interactive.location_request_message with the fixed send_location action", async () => {
    let captured: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        captured = JSON.parse(init?.body ?? "{}");
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.LOC_REQ_1" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const res = await metaProvider.sendInteractive!(
      {
        to: "96170000001",
        bodyText: "Share your pickup location, please.",
        kind: "location_request",
        options: [],
      },
      {
        phoneNumberId: "pn_1",
        accessToken: "tok",
        graphVersion: "v26.0",
      } as Parameters<NonNullable<typeof metaProvider.sendInteractive>>[1],
    );

    expect(res.externalId).toBe("wamid.LOC_REQ_1");
    expect(captured).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "96170000001",
      type: "interactive",
      interactive: {
        type: "location_request_message",
        body: { text: "Share your pickup location, please." },
        action: { name: "send_location" },
      },
    });
  });
});
