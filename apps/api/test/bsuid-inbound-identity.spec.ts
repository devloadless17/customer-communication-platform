/**
 * BSUID inbound identity — the message path must not drop a username-adopter.
 *
 * Meta's business-scoped-user-ids reference marks `from_user_id` and
 * `from_parent_user_id` as ADDED on `messages[]`, and marks `contacts[].wa_id` as
 * carrying a "New empty value" — it is empty "if the user has enabled the username
 * feature and you have not messaged the user's phone number in the last 30 days".
 *
 * The parser used to read only `messages[].from` and look the contact up in a map
 * keyed by wa_id/user_id. For such a customer BOTH are empty, so the lookup missed,
 * no BSUID was resolved, and the event was `continue`d — the inbound was dropped,
 * the webhook 200'd, and Meta never redelivered it. No row, no unread, no 24h
 * window, no workflow. The CALL path already had the correct fallback chain
 * (`parseMetaCall`) after the identical bug made inbound callers invisible; the
 * message path never got it.
 *
 * Username reserve/adopt went live 2026-06-29 and sending to a BSUID from July
 * 2026, so this is a live shape, not a future one.
 *
 * Pure parser tests — no DB, no bus.
 *
 *   pnpm --filter @ccp/api exec vitest run test/bsuid-inbound-identity.spec.ts
 */
import { describe, expect, it } from "vitest";

import { metaProvider } from "@/lib/providers/meta";

/** Envelope for one inbound `messages` change on a WhatsApp number. */
function envelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: "PN_1" },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

function inboundText(overrides: {
  from?: string;
  from_user_id?: string;
  contacts?: unknown[];
}) {
  return envelope({
    ...(overrides.contacts !== undefined ? { contacts: overrides.contacts } : {}),
    messages: [
      {
        ...(overrides.from !== undefined ? { from: overrides.from } : {}),
        ...(overrides.from_user_id !== undefined
          ? { from_user_id: overrides.from_user_id }
          : {}),
        id: "wamid.TEST1",
        timestamp: "1785400000",
        type: "text",
        text: { body: "hello" },
      },
    ],
  });
}

/** The single inbound-message event, or undefined if the parser dropped it. */
function inbound(payload: unknown) {
  return metaProvider
    .parseWebhook(payload)
    .find((e) => e.kind === "message") as
    | { kind: "message"; contactPhone?: string; bsuid?: string; username?: string }
    | undefined;
}

describe("BSUID inbound identity", () => {
  it("keeps the ordinary phone-identified inbound working", () => {
    const evt = inbound(
      inboundText({
        from: "15551234567",
        contacts: [{ profile: { name: "Ada" }, wa_id: "15551234567" }],
      }),
    );
    expect(evt).toBeDefined();
    expect(evt!.contactPhone).toBe("15551234567");
    expect(evt!.bsuid).toBeUndefined();
  });

  it("resolves the BSUID from messages[].from_user_id when `from` and wa_id are EMPTY", () => {
    // The exact documented shape for a username adopter outside the 30-day
    // phone window: `from` empty, `wa_id` empty, identity only in the BSUID
    // fields. This is the case that was silently dropped.
    const evt = inbound(
      inboundText({
        from: "",
        from_user_id: "LB.946402411360800",
        contacts: [
          {
            profile: { name: "Grace", username: "grace_co" },
            wa_id: "",
            user_id: "LB.946402411360800",
          },
        ],
      }),
    );
    expect(evt, "a username-adopter's message must not be dropped").toBeDefined();
    expect(evt!.bsuid).toBe("LB.946402411360800");
    expect(evt!.contactPhone).toBeUndefined();
  });

  it("falls back to contacts[].user_id when the message carries no from_user_id", () => {
    const evt = inbound(
      inboundText({
        from: "",
        contacts: [{ profile: { name: "Grace" }, wa_id: "", user_id: "LB.5551" }],
      }),
    );
    expect(evt).toBeDefined();
    expect(evt!.bsuid).toBe("LB.5551");
  });

  it("still treats a BSUID arriving in `from` as the identity (cold-contact shape)", () => {
    const evt = inbound(inboundText({ from: "LB.777", contacts: [] }));
    expect(evt).toBeDefined();
    expect(evt!.bsuid).toBe("LB.777");
    // A BSUID must never be digit-stripped into a phantom phone number.
    expect(evt!.contactPhone).toBeUndefined();
  });

  it("reads @username from contacts[].profile.username, not the top level", () => {
    // Meta nests it: `"profile": { "name": ..., "username": "<USERNAME>" }`.
    // It was declared as a sibling of wa_id, so `contact.username` was always
    // undefined and the only human-readable handle a phone-less contact has
    // never reached the inbox.
    const evt = inbound(
      inboundText({
        from: "",
        from_user_id: "LB.888",
        contacts: [
          { profile: { name: "Grace", username: "grace_co" }, wa_id: "", user_id: "LB.888" },
        ],
      }),
    );
    expect(evt).toBeDefined();
    expect(evt!.username).toBe("grace_co");
  });

  it("drops the event only when there is genuinely no identity at all", () => {
    const evt = inbound(inboundText({ from: "", contacts: [] }));
    expect(evt).toBeUndefined();
  });
});
