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
 * Mostly pure parser tests. The final describe drives the real ingest against
 * the dev database (bus mocked) for the parts a parser can't prove: the
 * parentBsuid third-rung resolve and the profile-country create rules.
 *
 *   pnpm --filter @ccp/api exec vitest run test/bsuid-inbound-identity.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";

vi.mock("@/lib/events/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/bus")>();
  return { ...actual, publish: vi.fn(async () => undefined) };
});

import { metaProvider } from "@/lib/providers/meta";
import { ingestWithRedelivery } from "./_ingest-redelivery";
import type {
  NormalizedCallEvent,
  NormalizedStatusUpdate,
} from "@ccp/shared/providers/types";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

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
    | {
        kind: "message";
        contactPhone?: string;
        bsuid?: string;
        parentBsuid?: string;
        countryCode?: string;
        username?: string;
      }
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

  it("carries the parent BSUID from messages[].from_parent_user_id", () => {
    const payload = inboundText({ from: "", from_user_id: "LB.100", contacts: [] });
    (
      (payload.entry[0]!.changes[0]!.value as { messages: Array<Record<string, unknown>> })
        .messages[0] as Record<string, unknown>
    ).from_parent_user_id = "US.ENT.100";
    const evt = inbound(payload);
    expect(evt).toBeDefined();
    expect(evt!.bsuid).toBe("LB.100");
    expect(evt!.parentBsuid).toBe("US.ENT.100");
  });

  it("falls back to contacts[].parent_user_id for the parent BSUID", () => {
    const evt = inbound(
      inboundText({
        from: "",
        contacts: [
          {
            profile: { name: "Grace" },
            wa_id: "",
            user_id: "LB.101",
            parent_user_id: "US.ENT.101",
          },
        ],
      }),
    );
    expect(evt).toBeDefined();
    expect(evt!.parentBsuid).toBe("US.ENT.101");
  });

  it("captures contacts[].profile.country_code on the identity fragment", () => {
    // The only country signal a phone-less contact has ("subject to change"
    // per the BSUID rollout notes) — ingest lets a phone-derived country win.
    const evt = inbound(
      inboundText({
        from: "",
        from_user_id: "LB.102",
        contacts: [
          { profile: { name: "Grace", country_code: "LB" }, wa_id: "", user_id: "LB.102" },
        ],
      }),
    );
    expect(evt).toBeDefined();
    expect(evt!.countryCode).toBe("LB");
  });
});

// ---------------------------------------------------------------------------
// Empty-string tolerance. The BSUID reference documents `from` / `wa_id` as
// "set to an empty string" in several shapes, and `"" ?? x` never falls
// through — so every identity read must treat `""` as absent. A `""` that
// slips through becomes a phantom identity key (or freezes a fallback chain),
// which is how the call path once dropped every username-adopter's call.
// ---------------------------------------------------------------------------
describe("empty strings never become identities", () => {
  function statuses(status: Record<string, unknown>): NormalizedStatusUpdate[] {
    return metaProvider
      .parseWebhook(envelope({ statuses: [status] }))
      .filter((e): e is NormalizedStatusUpdate => e.kind === "status");
  }

  function calls(call: Record<string, unknown>, contacts: unknown[] = []): NormalizedCallEvent[] {
    return metaProvider
      .parseWebhook(envelope({ contacts, calls: [call] }))
      .filter((e): e is NormalizedCallEvent => e.kind === "call");
  }

  it("statuses: recipient_id/recipient_user_id of \"\" yield NO recipient keys", () => {
    const [evt] = statuses({
      id: "wamid.EMPTY1",
      status: "delivered",
      timestamp: "1785400000",
      recipient_id: "",
      recipient_user_id: "",
      recipient_parent_user_id: "",
    });
    expect(evt, "the status itself must survive — wamid matching is unaffected").toBeDefined();
    expect(evt!.recipientId).toBeUndefined();
    expect(evt!.recipientBsuid).toBeUndefined();
    expect(evt!.recipientParentBsuid).toBeUndefined();
  });

  it("system.wa_id of \"\" never emits a number change", () => {
    const events = metaProvider.parseWebhook(
      envelope({
        contacts: [{ profile: { name: "Mover" }, wa_id: "96170000009" }],
        messages: [
          {
            from: "96170000009",
            id: "wamid.SYS_EMPTY",
            timestamp: "1785400000",
            type: "system",
            system: { type: "user_changed_number", wa_id: "" },
          },
        ],
      }),
    );
    expect(events.some((e) => e.kind === "contact_number_change")).toBe(false);
  });

  it("calls: from \"\" with from_user_id present still emits the call, keyed by BSUID", () => {
    // THE regression the empty-string guard fixed: `"" ?? x` froze bsuid at ""
    // and the inbound caller was invisible.
    const events = calls(
      {
        id: "wacid.EMPTY1",
        from: "",
        from_user_id: "LB.CALL1",
        event: "connect",
        direction: "USER_INITIATED",
        timestamp: "1785400000",
        session: { sdp_type: "offer", sdp: "v=0\r\n" },
      },
      [{ profile: { name: "Cold Caller" }, wa_id: "", user_id: "LB.CALL1" }],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.phase).toBe("incoming");
    expect(events[0]!.bsuid).toBe("LB.CALL1");
    expect(events[0]!.contactPhone).toBeUndefined();
  });

  it("calls: from \"\" with NO other identity is dropped, never \"\"-keyed", () => {
    const events = calls({
      id: "wacid.EMPTY2",
      from: "",
      event: "connect",
      direction: "USER_INITIATED",
      timestamp: "1785400000",
    });
    expect(events).toHaveLength(0);
  });

  it("call statuses: recipient_id \"\" falls through to recipient_user_id", () => {
    const events = metaProvider
      .parseWebhook(
        envelope({
          statuses: [
            {
              id: "wacid.EMPTY3",
              type: "call",
              status: "ACCEPTED",
              timestamp: "1785400000",
              recipient_id: "",
              recipient_user_id: "LB.CALL3",
            },
          ],
        }),
      )
      .filter((e): e is NormalizedCallEvent => e.kind === "call");
    expect(events).toHaveLength(1);
    expect(events[0]!.bsuid).toBe("LB.CALL3");
    expect(events[0]!.contactPhone).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ingest-side identity rules a parser test can't prove — real DB, bus mocked.
// ---------------------------------------------------------------------------
const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `bii${Date.now().toString().slice(-8)}`;

afterAll(async () => {
  await prisma.organization
    .deleteMany({ where: { name: `Bii Org ${S}` } })
    .catch(() => undefined);
  await prisma.$disconnect();
});

describe("ingest: parentBsuid third rung + profile country", () => {
  let workspaceId = "";
  let connA = "";

  async function setup() {
    if (workspaceId) return;
    const org = await prisma.organization.create({
      data: { name: `Bii Org ${S}`, status: "active" },
    });
    workspaceId = (
      await prisma.workspace.create({ data: { name: `Bii WS ${S}`, organizationId: org.id } })
    ).id;
    connA = (
      await prisma.channelConnection.create({
        data: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: `${S}_pn_a`,
          isDefault: true,
          isActive: true,
          config: { phoneNumberId: `${S}_pn_a`, displayPhoneNumber: "+1 555-020-0001" },
          secrets: {},
          messagingHealthUpdatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
  }

  it("resolves a NEW child bsuid through the stored parentBsuid (third rung) and backfills it", async () => {
    await setup();
    // The same person under a sibling portfolio: their stored child bsuid is
    // gone (nulled or never learned), only the cross-portfolio parent remains.
    const contact = await prisma.contact.create({
      data: {
        workspaceId,
        name: "Parent-keyed",
        identityChannel: "whatsapp",
        parentBsuid: "US.ENT.TR1",
      },
      select: { id: true },
    });

    const events = metaProvider.parseWebhook(
      envelope({
        contacts: [
          {
            profile: { name: "Parent-keyed" },
            wa_id: "",
            user_id: "LB.NEWCHILD1",
            parent_user_id: "US.ENT.TR1",
          },
        ],
        messages: [
          {
            from: "",
            from_user_id: "LB.NEWCHILD1",
            id: `wamid.${S}_TR1`,
            timestamp: "1785400000",
            type: "text",
            text: { body: "hello again" },
          },
        ],
      }),
    );
    await ingestWithRedelivery(workspaceId, "whatsapp", events, connA);

    // No second contact — the parent rung found the existing row…
    const holders = await prisma.contact.findMany({
      where: { workspaceId, parentBsuid: "US.ENT.TR1" },
      select: { id: true, bsuid: true },
    });
    expect(holders).toHaveLength(1);
    expect(holders[0]!.id).toBe(contact.id);
    // …and the missing child bsuid was backfilled onto it.
    expect(holders[0]!.bsuid).toBe("LB.NEWCHILD1");
    // The message landed on that contact's thread.
    const msg = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `wamid.${S}_TR1` },
      select: { conversation: { select: { contactId: true } } },
    });
    expect(msg.conversation.contactId).toBe(contact.id);
  });

  it("a BSUID-only create captures the profile's self-reported country", async () => {
    await setup();
    const events = metaProvider.parseWebhook(
      envelope({
        contacts: [
          {
            profile: { name: "Cold Country", country_code: "LB" },
            wa_id: "",
            user_id: "LB.CC1",
          },
        ],
        messages: [
          {
            from: "",
            from_user_id: "LB.CC1",
            id: `wamid.${S}_CC1`,
            timestamp: "1785400000",
            type: "text",
            text: { body: "hi" },
          },
        ],
      }),
    );
    await ingestWithRedelivery(workspaceId, "whatsapp", events, connA);

    const contact = await prisma.contact.findFirstOrThrow({
      where: { workspaceId, bsuid: "LB.CC1" },
      select: { phoneNumber: true, countryCode: true },
    });
    expect(contact.phoneNumber).toBeNull();
    expect(contact.countryCode).toBe("LB");
  });

  it("a phone-derived country always WINS over the profile assertion", async () => {
    await setup();
    // A Lebanese number asserting a US profile country: the phone is the
    // vendor-verified identity, the profile value is display-grade only.
    const phone = `96171${S.replace(/\D/g, "").slice(-5)}9`;
    const events = metaProvider.parseWebhook(
      envelope({
        contacts: [
          { profile: { name: "Warm Country", country_code: "US" }, wa_id: phone },
        ],
        messages: [
          {
            from: phone,
            id: `wamid.${S}_CC2`,
            timestamp: "1785400000",
            type: "text",
            text: { body: "hi" },
          },
        ],
      }),
    );
    await ingestWithRedelivery(workspaceId, "whatsapp", events, connA);

    const contact = await prisma.contact.findFirstOrThrow({
      where: { workspaceId, phoneNumber: phone },
      select: { countryCode: true },
    });
    expect(contact.countryCode).toBe("LB");
  });
});
