/**
 * Call artifacts (recording + transcript) — end to end through the REAL
 * pipeline: HMAC webhook → parse → ingest side-path → media download from the
 * (mock) Graph → R2 → the /v1 read endpoints.
 *
 * Exists because of a production incident on 2026-07-28: the transcript
 * webhook arrives under the WIRE name `call_transcript_available`, while
 * Meta's docs say `call_transcription_available` — the doc-faithful parser
 * dropped every live transcript. Case 3 pins BOTH names. The recording case
 * pins the full download chain (media descriptor → binary URL → storage →
 * streamed back byte-identical), and the CSW case pins the pricing-doc rule
 * that a MISSED inbound call still opens the 24h window at its arrival.
 *
 *   pnpm test:e2e:meta -- --grep "call artifacts"
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  wipeMetaTestTeam,
  postMetaWebhook,
  META_TEST_TEAM_ID,
  META_API_BASE,
  WA_PHONE_NUMBER_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString(36);
const BUSINESS_PHONE = "15559998888";

let apiToken = "";

test.beforeAll(async () => {
  ({ apiToken } = await seedMetaTestTeam());
});
test.afterAll(async () => {
  await wipeMetaTestTeam();
});

function callsWebhook(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-e2e",
        changes: [
          {
            field: "calls",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: BUSINESS_PHONE,
                phone_number_id: WA_PHONE_NUMBER_ID,
              },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

/** Ring + connected-terminate for a fresh inbound call, returning its row. */
async function seedConnectedCall(externalCallId: string, customerPhone: string) {
  const connect = await postMetaWebhook(
    META_TEST_TEAM_ID,
    callsWebhook({
      calls: [
        {
          id: externalCallId,
          to: BUSINESS_PHONE,
          from: customerPhone,
          event: "connect",
          timestamp: "1753660000",
          direction: "USER_INITIATED",
          session: { sdp_type: "offer", sdp: "v=0\r\n" },
        },
      ],
    }),
  );
  expect(connect.status).toBe(200);
  const terminate = await postMetaWebhook(
    META_TEST_TEAM_ID,
    callsWebhook({
      calls: [
        {
          id: externalCallId,
          to: BUSINESS_PHONE,
          from: customerPhone,
          event: "terminate",
          direction: "USER_INITIATED",
          timestamp: "1753660060",
          status: "COMPLETED",
          start_time: "1753660010",
          end_time: "1753660060",
          duration: 50,
        },
      ],
    }),
  );
  expect(terminate.status).toBe(200);
  const call = await db().call.findUnique({
    where: {
      workspaceId_channel_externalCallId: {
        workspaceId: META_TEST_TEAM_ID,
        channel: "whatsapp",
        externalCallId,
      },
    },
    select: { id: true, conversationId: true },
  });
  expect(call).not.toBeNull();
  return call!;
}

/** Poll a Call column until non-null (artifact downloads are detached). */
async function waitForCallField(
  callId: string,
  field: "recordingKey" | "transcriptKey",
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db().call.findUnique({
      where: { id: callId },
      select: { recordingKey: true, transcriptKey: true },
    });
    const value = row?.[field];
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for Call.${field} on ${callId}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

test.describe("call artifacts", () => {
  test("recording webhook → downloaded to our storage → streamed byte-identical by /v1", async () => {
    const externalCallId = `wacid.E2E_REC_${RUN}`;
    const mediaId = `artifact_rec_${RUN}`;
    const call = await seedConnectedCall(externalCallId, "15550002001");

    const hook = await postMetaWebhook(
      META_TEST_TEAM_ID,
      callsWebhook({
        calls: [
          {
            id: externalCallId,
            from: "15550002001",
            timestamp: "1753660070",
            event: "call_recording_available",
            call_recording: {
              type: "audio",
              audio: {
                id: mediaId,
                mime_type: "audio/ogg; codecs=opus",
                url: "http://127.0.0.1:9/dead-in-5-minutes", // deliberately unusable
              },
            },
          },
        ],
      }),
    );
    expect(hook.status).toBe(200);

    await waitForCallField(call.id, "recordingKey");

    // The stored bytes come back byte-identical through the /v1 stream — and
    // NOT via the webhook's short-lived url (pointed at a dead port above):
    // the durable media id is the only path that can have worked.
    const res = await fetch(
      `${META_API_BASE}/api/external/v1/calls/${call.id}/recording`,
      { headers: { authorization: `Bearer ${apiToken}` } },
    );
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer()).toString("utf8");
    expect(body).toBe(`OGGMOCKAUDIO_${mediaId}`);

    // /v1 list parity: the flags the UI reads.
    const list = await fetch(
      `${META_API_BASE}/api/external/v1/calls?conversationId=${call.conversationId}`,
      { headers: { authorization: `Bearer ${apiToken}` } },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      data: Array<{ id: string; has_recording: boolean }>;
    };
    const row = listBody.data.find((c) => c.id === call.id);
    expect(row?.has_recording).toBe(true);
  });

  test("transcript webhook under the LIVE wire name (call_transcript_available) → stored, Arabic detected", async () => {
    const externalCallId = `wacid.E2E_TR_${RUN}`;
    const mediaId = `artifact_json_${RUN}`;
    const call = await seedConnectedCall(externalCallId, "15550002002");

    const hook = await postMetaWebhook(
      META_TEST_TEAM_ID,
      callsWebhook({
        calls: [
          {
            id: externalCallId,
            from: "15550002002",
            timestamp: "1753660070",
            // The WIRE name — NOT the documented `call_transcription_available`.
            // Live-observed 2026-07-28; matching only the doc name silently
            // dropped every transcript.
            event: "call_transcript_available",
            call_transcript: {
              document: { id: mediaId, mime_type: "application/json" },
            },
          },
        ],
      }),
    );
    expect(hook.status).toBe(200);

    await waitForCallField(call.id, "transcriptKey");
    const row = await db().call.findUnique({
      where: { id: call.id },
      select: { transcriptLanguage: true },
    });
    expect(row?.transcriptLanguage).toBe("ar");

    const res = await fetch(
      `${META_API_BASE}/api/external/v1/calls/${call.id}/transcript`,
      { headers: { authorization: `Bearer ${apiToken}` } },
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      transcript?: { language?: string; text?: string };
    };
    expect(doc.transcript?.language).toBe("ar");
    expect(doc.transcript?.text).toContain("مرحبا");
  });

  test("the DOCUMENTED transcription event name is still accepted too", async () => {
    const externalCallId = `wacid.E2E_TR2_${RUN}`;
    const mediaId = `artifact_json2_${RUN}`;
    const call = await seedConnectedCall(externalCallId, "15550002003");

    const hook = await postMetaWebhook(
      META_TEST_TEAM_ID,
      callsWebhook({
        calls: [
          {
            id: externalCallId,
            from: "15550002003",
            timestamp: "1753660070",
            event: "call_transcription_available",
            call_transcript: {
              document: { id: mediaId, mime_type: "application/json" },
            },
          },
        ],
      }),
    );
    expect(hook.status).toBe(200);
    await waitForCallField(call.id, "transcriptKey");
  });

  test("a MISSED inbound call still opens the 24h window at its arrival (pricing-doc rule)", async () => {
    const externalCallId = `wacid.E2E_MISS_${RUN}`;
    const customerPhone = "15550002004";
    const ringTs = 1753661000;

    const connect = await postMetaWebhook(
      META_TEST_TEAM_ID,
      callsWebhook({
        calls: [
          {
            id: externalCallId,
            to: BUSINESS_PHONE,
            from: customerPhone,
            event: "connect",
            timestamp: String(ringTs),
            direction: "USER_INITIATED",
            session: { sdp_type: "offer", sdp: "v=0\r\n" },
          },
        ],
      }),
    );
    expect(connect.status).toBe(200);
    // COMPLETED without timing fields = nobody picked up (missed).
    const terminate = await postMetaWebhook(
      META_TEST_TEAM_ID,
      callsWebhook({
        calls: [
          {
            id: externalCallId,
            to: BUSINESS_PHONE,
            from: customerPhone,
            event: "terminate",
            direction: "USER_INITIATED",
            timestamp: String(ringTs + 45),
            status: "COMPLETED",
          },
        ],
      }),
    );
    expect(terminate.status).toBe(200);

    const call = await db().call.findUnique({
      where: {
        workspaceId_channel_externalCallId: {
          workspaceId: META_TEST_TEAM_ID,
          channel: "whatsapp",
          externalCallId,
        },
      },
      select: { status: true, conversation: { select: { contact: { select: { lastInboundAt: true } } } } },
    });
    expect(call?.status).toBe("missed");
    // Window anchored at the call's ARRIVAL ("regardless of if you accept the
    // call or not"), not nulled and not at terminate time.
    expect(call?.conversation.contact?.lastInboundAt?.getTime()).toBe(ringTs * 1000);
  });
});
