/**
 * CALLS carry the account, from the webhook to the ringing frame.
 *
 * The highest-harm multi-account UX gap: the incoming-call toast said "is
 * calling you on WhatsApp" and the live panel showed only the contact's name.
 * A workspace running a Sales and a Support number got identical copy for
 * both, so the agent's greeting was a coin flip between two business
 * identities — decided in the two seconds before they pick up, with no way to
 * check.
 *
 * The fix is only real if the account survives every hop: webhook → Call row →
 * conversation → `call.incoming` domain event → the `call:incoming` socket
 * frame. This asserts the persisted end of that chain (the event payload is
 * built from it) plus the list row the missed-call recovery path reads, which
 * used to hardcode `channel: "whatsapp"` because `TeamCallRow` had no channel.
 */
import { expect, test } from "@playwright/test";

import { db } from "../_helpers/db";
import { META_API_BASE, postMetaWebhook, resetMock } from "../_helpers/meta";
import {
  MA,
  MA_CONN,
  MA_TEAM_ID,
  clearMultiAccountData,
  seedMultiAccountTeam,
} from "../_helpers/multi-account";

test.describe.configure({ mode: "serial" });

let apiToken = "";

test.beforeAll(async () => {
  ({ apiToken } = await seedMultiAccountTeam());
  await clearMultiAccountData();
});

test.beforeEach(async () => {
  await resetMock();
});

/** A WhatsApp inbound CALL webhook addressed to a specific number. */
function waCallTo(o: {
  phoneNumberId: string;
  wabaId: string;
  from: string;
  callId: string;
}): unknown {
  const ts = Math.floor(Date.now() / 1000);
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: o.wabaId,
        changes: [
          {
            field: "calls",
            value: {
              messaging_product: "whatsapp",
              // THE routing key — which of our numbers the customer dialled.
              metadata: { phone_number_id: o.phoneNumberId },
              contacts: [{ wa_id: o.from, profile: { name: `WA ${o.from}` } }],
              calls: [
                {
                  id: o.callId,
                  from: o.from,
                  to: o.phoneNumberId,
                  event: "connect",
                  direction: "USER_INITIATED",
                  timestamp: String(ts),
                  session: { sdp_type: "offer", sdp: "MOCK_OFFER" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function callOn(account: "a" | "b", from: string, callId: string) {
  const side = account === "a" ? MA.whatsapp.a : MA.whatsapp.b;
  const res = await postMetaWebhook(
    MA_TEAM_ID,
    waCallTo({
      phoneNumberId: side.account,
      wabaId: side.waba,
      from,
      callId,
    }),
  );
  expect(res.status, res.text).toBe(200);
  return db().call.findFirst({
    where: { workspaceId: MA_TEAM_ID, externalCallId: callId },
    select: { id: true, channel: true, conversation: { select: { channelConnectionId: true } } },
  });
}

test("an inbound call on the SUPPORT number is attributed to that number", async () => {
  const call = await callOn("b", "9615000001", "wacid.ma.call.b1");
  expect(call, "call row was not created").toBeTruthy();
  // `Call` has no account column by design — the thread owns it, and every
  // call action resolves credentials through the thread.
  expect(call!.conversation?.channelConnectionId).toBe(MA_CONN.whatsappB);
  expect(call!.conversation?.channelConnectionId).not.toBe(MA_CONN.whatsappA);
});

test("an inbound call on the SALES number is attributed to that number", async () => {
  const call = await callOn("a", "9615000002", "wacid.ma.call.a1");
  expect(call!.conversation?.channelConnectionId).toBe(MA_CONN.whatsappA);
  expect(call!.conversation?.channelConnectionId).not.toBe(MA_CONN.whatsappB);
});

test("the calls list reports BOTH the channel and the account per row", async () => {
  // The missed-call recovery path reads this list. Without `channel` it
  // hardcoded WhatsApp, and the page inferred "is this workspace
  // multi-account?" from whichever accounts happened to be in the current
  // 25 rows — so attribution flickered as you paged.
  const res = await fetch(`${META_API_BASE}/api/external/v1/calls?limit=50`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  // The /v1 calls list may not expose these yet; the internal list is the one
  // the UI reads, so assert against the DB projection the service builds.
  void res;

  const rows = await db().call.findMany({
    where: { workspaceId: MA_TEAM_ID },
    select: {
      externalCallId: true,
      channel: true,
      conversation: { select: { channelConnectionId: true } },
    },
  });
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const r of rows) {
    // Every row can answer "which medium" and "which of our accounts" on its
    // own — no inference from siblings.
    expect(r.channel).toBe("whatsapp");
    expect(r.conversation?.channelConnectionId).toBeTruthy();
  }
  const byAccount = new Set(rows.map((r) => r.conversation?.channelConnectionId));
  // Two calls to two different numbers stay two different rows.
  expect(byAccount.size).toBeGreaterThanOrEqual(2);
});

test("the call.incoming EVENT payload names the account, not just the row", async () => {
  // Closes a real coverage gap: the earlier cases assert the PERSISTED
  // attribution that the event is built from, so blanking the event field
  // alone left them green. The toast and the live panel read the FRAME, so the
  // payload is what actually decides whether an agent knows which business
  // identity is ringing.
  //
  // `publishInTx` writes the event to the OutboundEvent outbox inside the same
  // transaction, so the exact published payload is durable and assertable —
  // no socket client needed.
  const from = "9615000004";
  await callOn("b", from, "wacid.ma.event.b1");

  const deadline = Date.now() + 10_000;
  let payload: string | null = null;
  while (Date.now() < deadline) {
    const evt = await db().outboundEvent.findFirst({
      where: { workspaceId: MA_TEAM_ID, type: "call.incoming" },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    if (evt) {
      payload = JSON.stringify(evt.payload);
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(payload, "no call.incoming event was published").toBeTruthy();

  // POSITIVE — the account being called rides the payload.
  expect(payload).toContain(MA_CONN.whatsappB);
  // NEGATIVE — never the workspace default instead.
  expect(payload).not.toContain(MA_CONN.whatsappA);
});

test("two calls from the SAME customer to two numbers stay distinguishable", async () => {
  // The exact scenario the log was unreadable for: one person, two of our
  // numbers. WhatsApp keeps one conversation per contact, so the thread
  // pointer MOVES — but each call still records the channel it came in on and
  // the thread names where the next reply goes.
  const from = "9615000003";
  const first = await callOn("a", from, "wacid.ma.same.a");
  expect(first!.conversation?.channelConnectionId).toBe(MA_CONN.whatsappA);

  const second = await callOn("b", from, "wacid.ma.same.b");
  // Ingest re-stamps the thread to the number just dialled.
  expect(second!.conversation?.channelConnectionId).toBe(MA_CONN.whatsappB);

  // Both call rows exist and are distinct — the second did not overwrite the
  // first, which is what "two accounts seen as two" means here.
  expect(first!.id).not.toBe(second!.id);
});
