/**
 * `send_conversions_event` workflow step — the Meta Conversions API loop for
 * business messaging (CTWA / click-to-Messenger ad optimization).
 *
 * What's worth proving is the wire and the skips, because both fail silently
 * in production: a wrong `user_data` key means Meta accepts the batch and
 * attributes nothing, and a contact with no ad click is the NORMAL case on a
 * mixed audience — erroring the run there would kill every workflow that
 * mixes organic and ad-sourced contacts.
 *
 *   pnpm --filter @ccp/api exec vitest run test/send-conversions-event.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import {
  buildConversionsEventBody,
  conversionsUserData,
} from "@/lib/providers/meta-conversions";
import { getStepHandler } from "@/lib/workflows/steps";
import { sendConversionsEventStepHandler } from "@/lib/workflows/steps/send-conversions-event";
import { StepConfigError } from "@/lib/workflows/steps/types";

import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `cv${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let seq = 0;

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

/** Stub fetch, capturing every Graph POST and replying per `responses`. */
function mockGraph(responses: unknown[]): Call[] {
  const calls: Call[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
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

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `CV Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `CV WS ${S}`, organizationId: orgId } })
  ).id;
});

async function makeThread(args: {
  channel: "whatsapp" | "messenger" | "instagram";
  connectionId?: string | null;
  externalContactId?: string | null;
}) {
  const n = seq++;
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `CV ${S} ${n}`,
      identityChannel: args.channel,
      ...(args.channel === "whatsapp"
        ? { phoneNumber: `+9856${S.slice(2)}${String(n).padStart(2, "0")}` }
        : { externalContactId: args.externalContactId ?? null }),
    },
    select: { id: true },
  });
  const convo = await prisma.conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: args.channel,
      ...(args.connectionId ? { channelConnectionId: args.connectionId } : {}),
    },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: convo.id };
}

function envelopeFor(args: {
  conversationId: string;
  channel: string;
  connectionId: string | null;
  contactId: string;
  externalContactId?: string | null;
}) {
  return {
    version: 1,
    event: "message_received",
    workspaceId,
    occurredAt: new Date().toISOString(),
    data: {
      conversation: {
        id: args.conversationId,
        channel: args.channel,
        channelConnectionId: args.connectionId,
      },
      contact: {
        id: args.contactId,
        externalContactId: args.externalContactId ?? null,
      },
    },
  } as unknown as Parameters<typeof sendConversionsEventStepHandler.run>[0];
}

function ctx() {
  return {
    workspaceId,
    workflowId: "wf_test",
    runId: "run_test",
    trigger: "message_received",
    attempt: 1,
    stepId: "step_1",
    graph: {},
    executionIndex: 0,
  } as unknown as Parameters<typeof sendConversionsEventStepHandler.run>[2];
}

function out(result: { body: string }): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Wire body — pure, per channel
// ---------------------------------------------------------------------------

describe("buildConversionsEventBody", () => {
  it("WhatsApp: WABA id + RAW ctwa_clid, action_source business_messaging", () => {
    const body = buildConversionsEventBody({
      channel: "whatsapp",
      eventName: "Purchase",
      eventTime: 1_700_000_000,
      eventId: "run:step:0",
      userData: conversionsUserData({
        channel: "whatsapp",
        wabaId: "WABA_1",
        ctwaClid: "CLID_raw",
      }),
      currency: "USD",
      value: 123,
    });
    const data = (body.data as Record<string, unknown>[])[0]!;
    expect(data.event_name).toBe("Purchase");
    expect(data.event_time).toBe(1_700_000_000);
    expect(data.event_id).toBe("run:step:0");
    expect(data.action_source).toBe("business_messaging");
    expect(data.messaging_channel).toBe("whatsapp");
    // ctwa_clid is never hashed.
    expect(data.user_data).toEqual({
      whatsapp_business_account_id: "WABA_1",
      ctwa_clid: "CLID_raw",
    });
    expect(data.custom_data).toEqual({ currency: "USD", value: 123 });
    // We never send the partner / automatic-events-only fields.
    expect(data).not.toHaveProperty("partner_agent");
    expect(data).not.toHaveProperty("messaging_outcome_data");
    expect(body).not.toHaveProperty("test_event_code");
  });

  it("Messenger: page_id + page_scoped_user_id; no custom_data unless configured", () => {
    const body = buildConversionsEventBody({
      channel: "messenger",
      eventName: "QualifiedLead",
      eventTime: 1,
      eventId: "e",
      userData: conversionsUserData({ channel: "messenger", pageId: "PAGE_1", psid: "PSID_1" }),
    });
    const data = (body.data as Record<string, unknown>[])[0]!;
    expect(data.messaging_channel).toBe("messenger");
    expect(data.user_data).toEqual({ page_id: "PAGE_1", page_scoped_user_id: "PSID_1" });
    expect(data).not.toHaveProperty("custom_data");
  });

  it("Instagram: ig_account_id (the reference name, not the sample's) + ig_sid; test_event_code is top-level", () => {
    const body = buildConversionsEventBody({
      channel: "instagram",
      eventName: "ViewContent",
      eventTime: 1,
      eventId: "e",
      userData: conversionsUserData({ channel: "instagram", igId: "IG_1", igsid: "IGSID_1" }),
      testEventCode: "TEST99",
    });
    const data = (body.data as Record<string, unknown>[])[0]!;
    expect(data.user_data).toEqual({ ig_account_id: "IG_1", ig_sid: "IGSID_1" });
    expect(data.user_data as Record<string, unknown>).not.toHaveProperty(
      "instagram_business_account_id",
    );
    expect(body.test_event_code).toBe("TEST99");
  });
});

// ---------------------------------------------------------------------------
// Config validation — publish-time rejection
// ---------------------------------------------------------------------------

describe("parseConfig", () => {
  const parse = (raw: unknown) => sendConversionsEventStepHandler.parseConfig(raw);

  it("rejects an unknown eventName", () => {
    expect(() => parse({ eventName: "SignedUp" })).toThrow(StepConfigError);
  });

  it("rejects value without currency (and vice versa)", () => {
    expect(() => parse({ eventName: "Purchase", value: 10 })).toThrow(StepConfigError);
    expect(() => parse({ eventName: "Purchase", currency: "USD" })).toThrow(StepConfigError);
  });

  it("normalizes currency and keeps the pair", () => {
    expect(parse({ eventName: "Purchase", currency: "usd", value: 9.5 })).toEqual({
      eventName: "Purchase",
      currency: "USD",
      value: 9.5,
    });
  });
});

// ---------------------------------------------------------------------------
// Handler — skips, journaling posture, end-to-end wire
// ---------------------------------------------------------------------------

describe("send_conversions_event handler", () => {
  it("is registered and journaled as irreversible (Meta does NOT dedupe — our journal is the dedup)", () => {
    const handler = getStepHandler("send_conversions_event");
    expect(handler).toBe(sendConversionsEventStepHandler);
    expect(handler.sideEffect).toBe("irreversible");
  });

  it("WhatsApp contact with no ad click id SKIPS and advances (no Graph call)", async () => {
    const calls = mockGraph([]);
    const wabaAccountId = await seedWabaAccount(prisma, workspaceId, `WABA_${S}_noclid`);
    const conn = await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `PN_${S}_noclid`,
        isDefault: true,
        wabaAccountId,
        config: { phoneNumberId: `PN_${S}_noclid` },
        // Plaintext passes decryptSecret unchanged (legacy-row behaviour).
        secrets: { accessToken: "wa-tok" },
      },
      select: { id: true },
    });
    const t = await makeThread({ channel: "whatsapp", connectionId: conn.id });
    const result = await sendConversionsEventStepHandler.run(
      envelopeFor({
        conversationId: t.conversationId,
        channel: "whatsapp",
        connectionId: conn.id,
        contactId: t.contactId,
      }),
      { eventName: "Purchase" },
      ctx(),
    );
    expect(result.kind).toBe("advance");
    expect(result.status).toBe(200);
    expect(out(result).skipped).toBe("no_ad_click_id");
    expect(calls).toHaveLength(0);
  });

  it("WhatsApp with a ctwa_clid on the first attributed inbound sends the event", async () => {
    const wabaExternalId = `WABA_${S}_send`;
    const wabaAccountId = await seedWabaAccount(prisma, workspaceId, wabaExternalId);
    const conn = await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `PN_${S}_send`,
        wabaAccountId,
        config: { phoneNumberId: `PN_${S}_send` },
        secrets: { accessToken: "wa-tok" },
      },
      select: { id: true },
    });
    const t = await makeThread({ channel: "whatsapp", connectionId: conn.id });
    await prisma.message.create({
      data: {
        workspaceId,
        conversationId: t.conversationId,
        externalId: `wamid.${S}.clid`,
        body: "hi from the ad",
        direction: "in",
        channel: "whatsapp",
        timestamp: new Date(),
        attribution: { source: "ad", adId: "AD_1", clickId: `CLID_${S}` },
      },
    });
    const calls = mockGraph([{ id: "DATASET_WA" }, { events_received: 1 }]);
    const result = await sendConversionsEventStepHandler.run(
      envelopeFor({
        conversationId: t.conversationId,
        channel: "whatsapp",
        connectionId: conn.id,
        contactId: t.contactId,
      }),
      { eventName: "Purchase" },
      ctx(),
    );
    expect(result.status).toBe(200);
    expect(out(result).datasetId).toBe("DATASET_WA");
    expect(calls).toHaveLength(2);
    // Dataset hangs off the WABA node for WhatsApp.
    expect(calls[0]!.url).toContain(`/${wabaExternalId}/dataset`);
    const data = (calls[1]!.body!.data as Record<string, unknown>[])[0]!;
    expect(data.user_data).toEqual({
      whatsapp_business_account_id: wabaExternalId,
      ctwa_clid: `CLID_${S}`,
    });
  });

  it("Messenger: resolves the dataset once, POSTs the event, persists + caches the dataset id", async () => {
    const pageId = `PAGE_${S}_send`;
    const calls = mockGraph([{ id: "DATASET_1" }, { events_received: 1 }]);
    const conn = await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "messenger",
        externalAccountId: pageId,
        isDefault: true,
        config: { pageId },
        secrets: { pageAccessToken: "pg-tok" },
      },
      select: { id: true },
    });
    const t = await makeThread({
      channel: "messenger",
      connectionId: conn.id,
      externalContactId: `PSID_${S}_1`,
    });
    const envelope = envelopeFor({
      conversationId: t.conversationId,
      channel: "messenger",
      connectionId: conn.id,
      contactId: t.contactId,
      externalContactId: `PSID_${S}_1`,
    });

    const result = await sendConversionsEventStepHandler.run(
      envelope,
      { eventName: "Purchase", currency: "USD", value: 50 },
      ctx(),
    );
    expect(result.kind).toBe("advance");
    expect(result.status).toBe(200);
    expect(out(result)).toMatchObject({
      datasetId: "DATASET_1",
      eventName: "Purchase",
      // runId:stepId:executionIndex — stable across BullMQ retries, distinct
      // per jump_to_step re-entry (StepRunContext contract).
      eventId: "run_test:step_1:0",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain(`/${pageId}/dataset`);
    expect(calls[1]!.url).toContain("/DATASET_1/events");
    const data = (calls[1]!.body!.data as Record<string, unknown>[])[0]!;
    expect(data.user_data).toEqual({
      page_id: pageId,
      page_scoped_user_id: `PSID_${S}_1`,
    });
    expect(data.custom_data).toEqual({ currency: "USD", value: 50 });
    expect(data.event_id).toBe("run_test:step_1:0");
    // event_time is unix SECONDS, stamped now.
    expect(Math.abs((data.event_time as number) - Date.now() / 1000)).toBeLessThan(60);

    // Dataset id persisted into the connection's config for restart survival…
    const row = await prisma.channelConnection.findUnique({
      where: { id: conn.id },
      select: { config: true },
    });
    expect((row!.config as Record<string, unknown>).capiDatasetId).toBe("DATASET_1");

    // …and the in-process cache makes a second event skip the /dataset edge.
    const calls2 = mockGraph([{ events_received: 1 }]);
    const again = await sendConversionsEventStepHandler.run(
      envelope,
      { eventName: "OrderShipped" },
      ctx(),
    );
    expect(again.status).toBe(200);
    expect(calls2).toHaveLength(1);
    expect(calls2[0]!.url).toContain("/DATASET_1/events");
  });

  it("Messenger contact without a PSID SKIPS; a Graph 4xx advances with the permission hint", async () => {
    const pageId = `PAGE_${S}_perm`;
    const conn = await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "messenger",
        externalAccountId: pageId,
        config: { pageId },
        secrets: { pageAccessToken: "pg-tok" },
      },
      select: { id: true },
    });
    // No PSID → skip before any network.
    const calls = mockGraph([]);
    const noPsid = await makeThread({ channel: "messenger", connectionId: conn.id });
    const skipped = await sendConversionsEventStepHandler.run(
      envelopeFor({
        conversationId: noPsid.conversationId,
        channel: "messenger",
        connectionId: conn.id,
        contactId: noPsid.contactId,
      }),
      { eventName: "Purchase" },
      ctx(),
    );
    expect(out(skipped).skipped).toBe("no_channel_user_id");
    expect(calls).toHaveLength(0);

    // Permission error from the dataset edge → actionable 422 advance, no throw.
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "(#200) Requires page_events", code: 200 } }),
            { status: 403 },
          ),
      ),
    );
    const t = await makeThread({
      channel: "messenger",
      connectionId: conn.id,
      externalContactId: `PSID_${S}_perm`,
    });
    const rejected = await sendConversionsEventStepHandler.run(
      envelopeFor({
        conversationId: t.conversationId,
        channel: "messenger",
        connectionId: conn.id,
        contactId: t.contactId,
        externalContactId: `PSID_${S}_perm`,
      }),
      { eventName: "Purchase" },
      ctx(),
    );
    expect(rejected.kind).toBe("advance");
    expect(rejected.status).toBe(422);
    expect(out(rejected).error).toBe("meta_conversions_rejected");
    expect(String(out(rejected).detail)).toContain("page_events");
  });

  it("non-Meta channel SKIPS rather than failing the run", async () => {
    const calls = mockGraph([]);
    const t = await makeThread({ channel: "whatsapp" });
    const result = await sendConversionsEventStepHandler.run(
      envelopeFor({
        conversationId: t.conversationId,
        channel: "webchatwidget",
        connectionId: null,
        contactId: t.contactId,
      }),
      { eventName: "Purchase" },
      ctx(),
    );
    expect(result.status).toBe(200);
    expect(out(result).skipped).toBe("unsupported_channel");
    expect(calls).toHaveLength(0);
  });
});
