import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

/**
 * Coexistence `history` webhook (history webhook reference doc). Pinned:
 *
 *  1. The ≤14-day MEDIA FOLLOW-UP shape — `field:"history"` with a plain
 *     `value.messages` array (the doc's second example) — is consumed. The
 *     branch used to walk `value.history` only, so every follow-up was
 *     silently dropped and the "📎 Media" placeholder could never resolve.
 *  2. `history_context.status` stamps backfilled ECHOES with the ticks they
 *     had earned (READ/PLAYED → read, PENDING → sent, ERROR → failed) instead
 *     of a flat default.
 *  3. The declined-sharing sentinel (2593109) still yields no events.
 */

const META = {
  messaging_product: "whatsapp",
  metadata: { display_phone_number: "15550783881", phone_number_id: "pn_1" },
};

function historyEnvelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      { id: "waba_1", changes: [{ field: "history", value: { ...META, ...value } }] },
    ],
  };
}

describe("history media follow-up (value.messages under field:history)", () => {
  it("consumes the doc's second example as an inbound message with media", () => {
    const events = metaProvider.parseWebhook(
      historyEnvelope({
        messages: [
          {
            from: "16505551234",
            id: "wamid.HISTORY_MEDIA_1",
            timestamp: "1738796547",
            type: "image",
            image: {
              caption: "Black Prince echeveria",
              mime_type: "image/jpeg",
              sha256: "3f9d…",
              id: "24230790383178626",
            },
          },
        ],
      }),
    );
    const msg = events.find((e) => e.kind === "message");
    expect(msg).toBeTruthy();
    if (msg?.kind !== "message") return;
    expect(msg.externalId).toBe("wamid.HISTORY_MEDIA_1");
    expect(msg.contactPhone).toBe("16505551234");
    expect(msg.media?.externalMediaId).toBe("24230790383178626");
    expect(msg.body).toBe("Black Prince echeveria");
  });

  it("classifies a business-sent follow-up as an echo (from = business number)", () => {
    const events = metaProvider.parseWebhook(
      historyEnvelope({
        messages: [
          {
            from: "15550783881",
            to: "16505551234",
            id: "wamid.HISTORY_MEDIA_2",
            timestamp: "1738796547",
            type: "image",
            image: { mime_type: "image/jpeg", id: "999" },
            history_context: { status: "PLAYED" },
          },
        ],
      }),
    );
    const echo = events.find((e) => e.kind === "echo");
    if (echo?.kind !== "echo") throw new Error("no echo event");
    expect(echo.contactPhone).toBe("16505551234");
    expect(echo.status).toBe("read"); // PLAYED collapses to read
  });
});

describe("history_context.status on thread backfill echoes", () => {
  it("stamps READ / maps ERROR to failed / leaves unknown to the default", () => {
    const events = metaProvider.parseWebhook(
      historyEnvelope({
        history: [
          {
            metadata: { phase: 0, chunk_order: 1, progress: 55 },
            threads: [
              {
                id: "16505551234",
                messages: [
                  {
                    from: "15550783881",
                    id: "wamid.H1",
                    timestamp: "1739230955",
                    type: "text",
                    text: { body: "Here's the info you requested!" },
                    history_context: { status: "READ" },
                  },
                  {
                    from: "15550783881",
                    id: "wamid.H2",
                    timestamp: "1739230956",
                    type: "text",
                    text: { body: "resend" },
                    history_context: { status: "ERROR" },
                  },
                  {
                    from: "15550783881",
                    id: "wamid.H3",
                    timestamp: "1739230957",
                    type: "text",
                    text: { body: "???" },
                    history_context: { status: "SOMETHING_NEW" },
                  },
                  {
                    from: "16505551234",
                    id: "wamid.H4",
                    timestamp: "1739230970",
                    type: "text",
                    text: { body: "Thanks!" },
                    history_context: { status: "READ" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const echoes = events.filter((e) => e.kind === "echo");
    expect(echoes).toHaveLength(3);
    const byId = new Map(echoes.map((e) => [e.kind === "echo" ? e.externalId : "", e]));
    expect((byId.get("wamid.H1") as { status?: string }).status).toBe("read");
    expect((byId.get("wamid.H2") as { status?: string }).status).toBe("failed");
    expect((byId.get("wamid.H3") as { status?: string }).status).toBeUndefined();
    // The customer's own message is inbound, never an echo.
    expect(events.filter((e) => e.kind === "message")).toHaveLength(1);
  });
});

describe("declined sharing", () => {
  it("the 2593109 sentinel yields no events (value-level and chunk-level)", () => {
    const declined = {
      errors: [{ code: 2593109, title: "History sync is turned off" }],
    };
    expect(metaProvider.parseWebhook(historyEnvelope(declined))).toHaveLength(0);
    expect(
      metaProvider.parseWebhook(historyEnvelope({ history: [declined] })),
    ).toHaveLength(0);
  });
});

describe("smb_message_echoes owner-side corrections (smb-message-echoes doc)", () => {
  function echoEnvelope(echo: Record<string, unknown>) {
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "smb_message_echoes",
              value: { ...META, message_echoes: [echo] },
            },
          ],
        },
      ],
    };
  }

  it("a revoke echo becomes a DELETE correction pinned to OUTBOUND rows", () => {
    const events = metaProvider.parseWebhook(
      echoEnvelope({
        from: "15550783881",
        to: "16505551234",
        id: "wamid.REVOKE_EVENT",
        timestamp: "1749854575",
        type: "revoke",
        revoke: { original_message_id: "wamid.ORIGINAL_1" },
      }),
    );
    const corr = events.find((e) => e.kind === "message_correction");
    if (corr?.kind !== "message_correction") throw new Error("no correction");
    expect(corr.action).toBe("delete");
    expect(corr.targetExternalId).toBe("wamid.ORIGINAL_1");
    expect(corr.expectedDirection).toBe("out");
    // No phantom echo row for the revoke event itself.
    expect(events.find((e) => e.kind === "echo")).toBeUndefined();
  });

  it("an edit echo becomes an EDIT correction carrying the new caption", () => {
    const events = metaProvider.parseWebhook(
      echoEnvelope({
        from: "15550783881",
        to: "16505551234",
        id: "wamid.EDIT_EVENT",
        timestamp: "1749854620",
        type: "edit",
        edit: {
          original_message_id: "wamid.ORIGINAL_2",
          message: {
            type: "image",
            image: { caption: "Updated image caption", mime_type: "image/jpeg", id: "1234567890" },
          },
        },
      }),
    );
    const corr = events.find((e) => e.kind === "message_correction");
    if (corr?.kind !== "message_correction") throw new Error("no correction");
    expect(corr.action).toBe("edit");
    expect(corr.targetExternalId).toBe("wamid.ORIGINAL_2");
    expect(corr.newBody).toBe("Updated image caption");
    expect(corr.expectedDirection).toBe("out");
  });

  it("a plain text echo still lands as an ordinary echo (doc's first example)", () => {
    const events = metaProvider.parseWebhook(
      echoEnvelope({
        from: "15550783881",
        to: "16505551234",
        id: "wamid.PLAIN_ECHO",
        timestamp: "1739321024",
        type: "text",
        text: { body: "Here's the info you requested!" },
      }),
    );
    const echo = events.find((e) => e.kind === "echo");
    if (echo?.kind !== "echo") throw new Error("no echo");
    expect(echo.contactPhone).toBe("16505551234");
    expect(echo.body).toBe("Here's the info you requested!");
  });
});
