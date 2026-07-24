import { test, expect, type Page } from "@playwright/test";

import { createHmac } from "node:crypto";

import { db, appAdmin, wipeTestData } from "../_helpers/db";
import { encryptSecret } from "../../../apps/api/src/lib/crypto/envelope-core";

/**
 * The API's own origin. The webhook lands here rather than through the Next
 * proxy: `/webhooks/*` is an api-only route, and we want the REAL ingest →
 * event-bus → socket chain, not a simulated frame.
 */
const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

/**
 * The BROWSER half of a call: ringing → answered → timer → teardown.
 *
 * This file exists because that boundary had no coverage and shipped broken.
 * The refactor moved pickup detection off a browser heuristic and onto
 * WhatsApp's authoritative `ACCEPTED` call status — correctly — but nothing
 * subscribed to the socket frame that replaced it. `use-call.ts` listened to
 * `call:sdp_offer` and `call:ended` only. Every outbound call sat on "Calling…"
 * with a dead timer while the two parties talked, and typecheck, lint and 115
 * e2e specs all passed.
 *
 * The server side of that chain is covered by
 * meta-channels/whatsapp-calling-webhooks.spec.ts. What is asserted HERE is the
 * part those cannot see: that the page actually reacts to the frames.
 *
 * WebRTC is stubbed. A real peer connection cannot be established against
 * WhatsApp from a test, and it isn't what's under test — the media path is the
 * browser's job, while the state machine driving what the agent SEES is ours.
 * The stub is deliberately faithful about the handful of calls the hook makes.
 */

const PHONE = "+33611119001";
let workspaceId: string;
let userId: string;
let conversationId: string;
// The connection's stored phone-number id. The webhook controller matches
// `value.metadata.phone_number_id` against it and drops a mismatch FAIL-SOFT
// (200, no write) — so a wrong id here would make this spec pass vacuously.
const phoneNumberId = "e2e_ui_wa_phone";
// The webhook needs a real config to resolve at all — a missing appSecret is a
// 403 `no_config`, which the dev signature-skip flag does NOT cover (it skips
// verification, not the config lookup). So sign properly, exactly as Meta does.
const APP_SECRET = "e2e_ui_call_app_secret_0123456789";

/**
 * Replace getUserMedia + RTCPeerConnection before any app code runs.
 *
 * The hook needs: a mic stream with a real audio track (it toggles
 * `track.enabled` for mute and for holding audio across the accept handshake),
 * an offer/answer it can set as local/remote descriptions, and a
 * `connectionstatechange` it can await. Everything else is inert.
 */
async function stubWebRtc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const FAKE_SDP = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

    const track = {
      kind: "audio",
      enabled: true,
      stop() {},
      addEventListener() {},
      removeEventListener() {},
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      addTrack() {},
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });

    class FakePeerConnection extends EventTarget {
      connectionState = "new";
      signalingState = "stable";
      localDescription: unknown = null;
      remoteDescription: unknown = null;
      onconnectionstatechange: (() => void) | null = null;
      ontrack: (() => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      addTrack() {
        return {};
      }
      async createOffer() {
        return { type: "offer", sdp: FAKE_SDP };
      }
      async createAnswer() {
        return { type: "answer", sdp: FAKE_SDP };
      }
      async setLocalDescription(d: unknown) {
        this.localDescription = d;
        // Mirrors the browser: an offer set locally moves us out of `stable`,
        // which the hook checks before applying a remote answer.
        this.signalingState = "have-local-offer";
      }
      async setRemoteDescription(d: unknown) {
        this.remoteDescription = d;
        this.signalingState = "stable";
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
        this.dispatchEvent(new Event("connectionstatechange"));
      }
      async getStats() {
        return new Map();
      }
      getSenders() {
        return [];
      }
      close() {
        this.connectionState = "closed";
      }
    }
    (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection;
  });
}

/**
 * Seed the call row the intercepted POST will hand back, in the state
 * `placeCall` would have left it: ringing, attributed to this agent.
 */
async function seedRingingOutboundCall(externalCallId: string) {
  return db().call.create({
    data: {
      workspaceId,
      conversationId,
      externalCallId,
      channel: "whatsapp",
      direction: "out",
      status: "ringing",
      ringingAt: new Date(),
      initiatedByUserId: userId,
      rawPayload: {},
    },
    select: { id: true },
  });
}

test.beforeAll(async () => {
  await wipeTestData();
  const su = await appAdmin();
  workspaceId = su.workspaceId;
  userId = su.userId;

  const contact = await db().contact.create({
    data: {
      workspaceId,
      phoneNumber: PHONE,
      identityChannel: "whatsapp",
      name: "Call Panel E2E",
      source: "manual",
      // Inside the service window, so nothing upstream of the call button
      // hides it for an unrelated reason.
      lastInboundAt: new Date(),
    },
    select: { id: true },
  });
  const conv = await db().conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(),
      lastMessagePreview: "hi",
    },
    select: { id: true },
  });
  conversationId = conv.id;

  // A WhatsApp connection has to exist for the webhook to resolve this team,
  // and its phoneNumberId has to match what the payload carries.
  //
  // Clear any OTHER default before claiming it: a partial unique
  // (`ChannelConnection_one_default_per_channel`) allows exactly one default per
  // (workspace, channel), so an account left as default by an earlier spec makes
  // this create a P2002 — which surfaces as a beforeAll failure and takes every
  // test in the file with it. Same order the product's `setDefaultAccount` uses.
  const connectionConfig = {
    phoneNumberId,
    displayPhoneNumber: "+33600000000",
    verifyToken: "e2e-ui-verify",
  };
  await db().$transaction(async (tx) => {
    await tx.channelConnection.updateMany({
      where: {
        workspaceId,
        channel: "whatsapp",
        isDefault: true,
        NOT: { externalAccountId: phoneNumberId },
      },
      data: { isDefault: false },
    });
    await tx.channelConnection.upsert({
      where: {
        workspaceId_channel_externalAccountId: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: phoneNumberId,
        },
      },
      create: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: phoneNumberId,
        isDefault: true,
        config: connectionConfig,
        secrets: { appSecret: encryptSecret(APP_SECRET) },
        isActive: true,
      },
      update: {
        isDefault: true,
        config: connectionConfig,
        secrets: { appSecret: encryptSecret(APP_SECRET) },
        isActive: true,
      },
    });
  });
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

test("the panel leaves 'Calling…' and starts the timer when the customer picks up", async ({
  page,
}) => {
  const externalCallId = `wacid.ui.${Date.now()}`;
  const call = await seedRingingOutboundCall(externalCallId);
  await stubWebRtc(page);

  // Stand in for the real placeCall so the test needs no WhatsApp credentials.
  // Everything AFTER this point — the socket frame and the panel's reaction to
  // it — is the real thing.
  await page.route("**/api/conversations/*/call", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        callId: call.id,
        externalCallId,
        status: "ringing",
      }),
    });
  });

  await page.goto(`/inbox?c=${conversationId}`, { waitUntil: "domcontentloaded" });
  // The thread header's call button. Matched on its aria-label rather than a
  // test id so this also asserts the control stays reachable to assistive tech.
  const callButton = page.getByRole("button", {
    name: /Start a .* call with this contact/i,
  });
  await expect(callButton).toBeVisible({ timeout: 20_000 });
  await callButton.click();

  const panel = page.getByText(/Calling…|Calling\.\.\./);
  await expect(panel).toBeVisible({ timeout: 10_000 });

  // The customer answers. Posted as a REAL webhook so the whole chain runs —
  // parseWebhook → ingest → event bus → socket → this page. That chain is
  // exactly what was broken, and the browser end of it is what this asserts.
  const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-ui-e2e",
          changes: [
            {
              field: "calls",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "33600000000",
                  phone_number_id: phoneNumberId,
                },
                statuses: [
                  {
                    id: externalCallId,
                    type: "call",
                    status: "ACCEPTED",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: PHONE.replace("+", ""),
                  },
                ],
              },
            },
          ],
        },
      ],
  });
  // HMAC over the RAW bytes we send, same as Meta.
  const res = await fetch(`${API_BASE}/webhooks/meta/${workspaceId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  expect(res.status).toBe(200);

  // "Calling…" must be replaced by a running duration. Asserting the timer —
  // not merely a status string — is the point: the bug was a panel that looked
  // busy while the clock never moved.
  await expect(page.getByText(/^\d{1,2}:\d{2}$/)).toBeVisible({ timeout: 10_000 });
  await expect(panel).toBeHidden();
});

test("a reload during a live call releases the customer instead of stranding them", async ({
  page,
}) => {
  const externalCallId = `wacid.reload.${Date.now()}`;
  const call = await db().call.create({
    data: {
      workspaceId,
      conversationId,
      externalCallId,
      channel: "whatsapp",
      direction: "out",
      status: "in_progress",
      ringingAt: new Date(Date.now() - 30_000),
      answeredAt: new Date(Date.now() - 25_000),
      initiatedByUserId: userId,
      rawPayload: {},
    },
    select: { id: true },
  });

  await stubWebRtc(page);
  await page.goto("/inbox", { waitUntil: "domcontentloaded" });
  // Mark this tab as mid-call, exactly as the hook does while a call is live,
  // then reload. A reload destroys the peer connection, so the media is
  // provably dead — leaving the row `in_progress` would sit the customer on a
  // silent line until the stale-call sweeper noticed.
  await page.evaluate(
    (callId) => window.sessionStorage.setItem("ccp.call.activeCallId", callId),
    call.id,
  );
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect
    .poll(
      async () => {
        const row = await db().call.findUnique({
          where: { id: call.id },
          select: { status: true },
        });
        return row?.status;
      },
      { timeout: 15_000, message: "reload should have terminated the live call" },
    )
    .toBe("completed");
});
