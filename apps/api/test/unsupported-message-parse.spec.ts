/**
 * Inbound `type: "unsupported"` — what the provider stores, and what it doesn't.
 *
 * The Cloud API delivers some messages as `unsupported` with NO body at all: a
 * poll, a view-once, or a template another business sent to our API number
 * (Meta's documented trigger: "You use the API to send a message to a number
 * already in use with the API … Cloud API sends the webhook to the owner of the
 * recipient number"). A client's Instagram verification code arrived exactly so.
 *
 * The properties that carry the risk:
 *
 *   1. **`Message.body` holds Meta's facts only** — the kind and Meta's own
 *      sentence. The human explanation lives in the web layer. It used to be
 *      baked into the body, where keyword routing rules read it: a rule on
 *      "code" or "business" started routing every unsupported message.
 *   2. **Meta's facts ride on `structured`** — type, code, reason — so the web
 *      can explain the kind, and 131060 ("currently unavailable") stays
 *      distinguishable from 131051 ("type not supported").
 *   3. **A wire-supplied `type` is data, never a lookup key into an object.**
 *      `constructor` must not resolve down the prototype chain.
 *
 *   pnpm --filter @ccp/api exec vitest run test/unsupported-message-parse.spec.ts
 */
import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

function unsupportedEnvelope(opts: {
  type?: string;
  code?: number;
  title?: string;
  details?: string;
}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba_1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: "pn_1" },
              contacts: [{ wa_id: "447723442693", profile: { name: "" } }],
              messages: [
                {
                  from: "447723442693",
                  id: `wamid.UNSUPPORTED_${opts.type ?? "none"}`,
                  timestamp: "1790000000",
                  type: "unsupported",
                  ...(opts.code !== undefined
                    ? {
                        errors: [
                          {
                            code: opts.code,
                            title: opts.title ?? "Message type unknown",
                            message: opts.title ?? "Message type unknown",
                            error_data: {
                              details: opts.details ?? "Message type is currently not supported.",
                            },
                          },
                        ],
                      }
                    : {}),
                  ...(opts.type ? { unsupported: { type: opts.type } } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function messageOf(payload: unknown) {
  const msg = metaProvider.parseWebhook(payload).find((e) => e.kind === "message");
  expect(msg).toBeTruthy();
  return msg as unknown as { body: string; structured?: Record<string, unknown> };
}

describe("inbound unsupported messages", () => {
  it("stores Meta's facts in the body, and NO explanation copy", () => {
    const msg = messageOf(unsupportedEnvelope({ type: "hsm", code: 131051 }));
    expect(msg.body).toBe("⚠️ Unsupported message (hsm) — Message type is currently not supported.");
    // The words a keyword routing rule would catch are presentation now.
    expect(msg.body).not.toMatch(/verification|business|template|code/i);
  });

  it("carries type, code and Meta's reason on `structured`", () => {
    const msg = messageOf(unsupportedEnvelope({ type: "hsm", code: 131051 }));
    expect(msg.structured).toEqual({
      kind: "unsupported",
      type: "hsm",
      code: 131051,
      reason: "Message type is currently not supported.",
    });
  });

  it("keeps 131060 distinguishable — a different thing from 131051", () => {
    const msg = messageOf(
      unsupportedEnvelope({
        code: 131060,
        title: "This message is currently unavailable.",
        details: "This message is currently unavailable.",
      }),
    );
    expect(msg.structured).toMatchObject({ kind: "unsupported", code: 131060 });
    expect(msg.body).toContain("currently unavailable");
  });

  it("treats a prototype-named type as plain data", () => {
    const msg = messageOf(unsupportedEnvelope({ type: "constructor", code: 131051 }));
    expect(msg.body).toBe(
      "⚠️ Unsupported message (constructor) — Message type is currently not supported.",
    );
    expect(msg.body).not.toContain("function");
    expect(msg.structured).toMatchObject({ kind: "unsupported", type: "constructor" });
  });

  /**
   * The same payload arrives through the Coexistence HISTORY backfill (and the
   * echo path) too, which build content through a different function. Before
   * this, those rows kept neither the explanation (it moved out of the body)
   * nor the card that replaced it.
   */
  it("carries the structured card through a history backfill as well", () => {
    const events = metaProvider.parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "history",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550783881", phone_number_id: "pn_1" },
                history: [
                  {
                    metadata: { phase: 0, chunk_order: 1, progress: 100 },
                    threads: [
                      {
                        id: "447723442693",
                        messages: [
                          {
                            from: "447723442693",
                            id: "wamid.HISTORY_UNSUPPORTED_1",
                            timestamp: "1790000000",
                            type: "unsupported",
                            unsupported: { type: "hsm" },
                            errors: [
                              {
                                code: 131051,
                                title: "Message type unknown",
                                error_data: { details: "Message type is currently not supported." },
                              },
                            ],
                            history_context: { status: "DELIVERED" },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const msg = events.find((e) => "externalId" in e && e.externalId === "wamid.HISTORY_UNSUPPORTED_1");
    expect(msg).toBeTruthy();
    expect((msg as unknown as { structured?: unknown }).structured).toEqual({
      kind: "unsupported",
      type: "hsm",
      code: 131051,
      reason: "Message type is currently not supported.",
    });
  });

  it("still produces a placeholder when Meta sends no type and no error", () => {
    const msg = messageOf(unsupportedEnvelope({}));
    expect(msg.body).toBe("⚠️ Unsupported message");
    expect(msg.structured).toEqual({ kind: "unsupported" });
  });
});
