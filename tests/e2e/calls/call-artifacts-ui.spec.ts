/**
 * Call recording/transcript UI — the first browser coverage of these surfaces.
 *
 * Everything below the UI is covered elsewhere (the pipeline in
 * apps/api/test/call-transcript-*.spec.ts, the Meta artifact path in
 * meta-channels/whatsapp-call-artifacts.spec.ts). What had NO test was the
 * part the user actually sees: that a stored transcript renders as an
 * Agent/Customer dialogue in the thread bubble and the contact panel's Calls
 * tab, and that the "Transcribing…" state now SURVIVES a reload (it used to
 * be live-frame-only, so refreshing mid-transcription lost the chip and the
 * gap read as "no transcript").
 *
 * Seeds its own rows only (no wipeTestData) and cleans them up, so a live
 * manual session is undisturbed. The transcript document is written through
 * the api's own blobStorage binding — the test process and the app read the
 * same root .env, so they resolve the same storage backend.
 *
 *   pnpm test:e2e tests/e2e/calls/call-artifacts-ui.spec.ts
 */
import { test, expect } from "@playwright/test";

import { db, appAdmin } from "../_helpers/db";
import { blobStorage } from "../../../apps/api/src/lib/blob-storage";

let workspaceId: string;
let conversationId: string;
let contactId: string;
let connectionId: string;
let doneCallId: string;
let pendingCallId: string;
const storedKeys: string[] = [];

const AGENT_LINE = "مرحبا، كيف فيني ساعدك اليوم؟";
const CUSTOMER_LINE = "بدي اسأل عن طلبي اذا بتريد.";

test.beforeAll(async () => {
  const su = await appAdmin();
  workspaceId = su.workspaceId;

  // A WhatsApp connection with transcription ON — `transcriptPending` is
  // DERIVED from this config on hydrate, which is the behavior under test.
  // Claimed as default with the same care call-panel-lifecycle documents
  // (partial unique: one default per (workspace, channel)).
  const externalAccountId = "e2e_artifacts_ui_phone";
  await db().$transaction(async (tx) => {
    await tx.channelConnection.updateMany({
      where: {
        workspaceId,
        channel: "whatsapp",
        isDefault: true,
        NOT: { externalAccountId },
      },
      data: { isDefault: false },
    });
    connectionId = (
      await tx.channelConnection.upsert({
        where: {
          workspaceId_channel_externalAccountId: {
            workspaceId,
            channel: "whatsapp",
            externalAccountId,
          },
        },
        create: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId,
          isDefault: true,
          isActive: true,
          config: {
            callRecording: { enabled: true },
            callTranscription: { enabled: true },
          },
        },
        update: {
          isDefault: true,
          isActive: true,
          config: {
            callRecording: { enabled: true },
            callTranscription: { enabled: true },
          },
        },
        select: { id: true },
      })
    ).id;
  });

  contactId = (
    await db().contact.create({
      data: {
        workspaceId,
        phoneNumber: "+33611119002",
        identityChannel: "whatsapp",
        name: "Artifacts UI E2E",
        source: "manual",
        lastInboundAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  conversationId = (
    await db().conversation.create({
      data: {
        workspaceId,
        contactId,
        channel: "whatsapp",
        status: "open",
        channelConnectionId: connectionId,
        lastMessageAt: new Date(),
        lastMessagePreview: "call artifacts",
      },
      select: { id: true },
    })
  ).id;

  const ended = new Date(Date.now() - 5 * 60 * 1000);
  // Call 1: fully processed — recording + speaker-attributed transcript.
  doneCallId = (
    await db().call.create({
      data: {
        workspaceId,
        conversationId,
        externalCallId: `wacid.ui.artifacts.${Date.now()}`,
        channel: "whatsapp",
        direction: "out",
        status: "completed",
        ringingAt: new Date(ended.getTime() - 60_000),
        answeredAt: new Date(ended.getTime() - 50_000),
        endedAt: ended,
        durationSeconds: 50,
        rawPayload: {},
      },
      select: { id: true },
    })
  ).id;
  const recordingKey = `call-recordings/${workspaceId}/${doneCallId}.ogg`;
  const transcriptKey = `call-transcripts/${workspaceId}/${doneCallId}.json`;
  await blobStorage.putObject({
    key: recordingKey,
    bytes: new TextEncoder().encode("OGG_UI_FIXTURE"),
    contentType: "audio/ogg",
  });
  await blobStorage.putObject({
    key: transcriptKey,
    bytes: new TextEncoder().encode(
      JSON.stringify({
        metadata: {
          processed_at: new Date().toISOString(),
          source: "inapp",
          channels: "per-speaker",
          dialect_repaired: false,
        },
        transcript: {
          text: `Agent: ${AGENT_LINE}\nCustomer: ${CUSTOMER_LINE}`,
          language: "ar",
          segments: [
            { id: 0, speaker: "Business", start: 0.8, text: AGENT_LINE },
            { id: 1, speaker: "Customer", start: 4.2, text: CUSTOMER_LINE },
          ],
        },
      }),
    ),
    contentType: "application/json",
  });
  storedKeys.push(recordingKey, transcriptKey);
  await db().call.update({
    where: { id: doneCallId },
    data: {
      recordingKey,
      recordingMimeType: "audio/ogg",
      transcriptKey,
      transcriptLanguage: "ar",
    },
  });

  // Call 2: recording finalized, transcript still owed — the state a reload
  // used to render indistinguishably from "never transcribed".
  pendingCallId = (
    await db().call.create({
      data: {
        workspaceId,
        conversationId,
        externalCallId: `wacid.ui.pending.${Date.now()}`,
        channel: "whatsapp",
        direction: "in",
        status: "completed",
        ringingAt: new Date(ended.getTime() + 60_000),
        answeredAt: new Date(ended.getTime() + 65_000),
        endedAt: new Date(ended.getTime() + 120_000),
        durationSeconds: 55,
        recordingKey: `call-recordings/${workspaceId}/pending-ui.ogg`,
        recordingMimeType: "audio/ogg",
        rawPayload: {},
      },
      select: { id: true },
    })
  ).id;
});

test.afterAll(async () => {
  await blobStorage.delete(storedKeys).catch(() => undefined);
  await db().call.deleteMany({ where: { id: { in: [doneCallId, pendingCallId] } } });
  await db().conversation.deleteMany({ where: { id: conversationId } });
  await db().contact.deleteMany({ where: { id: contactId } });
  // Same rule as call-panel-lifecycle: a leftover WhatsApp connection breaks
  // later specs that assert the workspace is unconfigured.
  await db().channelConnection.deleteMany({ where: { id: connectionId } });
  await db().$disconnect();
});

test("the thread bubble renders the transcript as an Agent/Customer dialogue", async ({
  page,
}) => {
  await page.goto(`/inbox?c=${conversationId}`);

  // The processed call's bubble carries both artifact buttons.
  const transcriptButton = page.getByRole("button", { name: "Show transcript" }).first();
  await expect(transcriptButton).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "Play recording" }).first(),
  ).toBeVisible();

  await transcriptButton.click();
  // Speaker-attributed turns, not a flat blob: both labels, both lines.
  await expect(page.getByText("Agent", { exact: true })).toBeVisible();
  await expect(page.getByText("Customer", { exact: true })).toBeVisible();
  await expect(page.getByText(AGENT_LINE)).toBeVisible();
  await expect(page.getByText(CUSTOMER_LINE)).toBeVisible();
});

test("the 'Transcribing…' state survives a page load (derived, not frame-only)", async ({
  page,
}) => {
  // Fresh hydration — no live frame ever reaches this page. The chip must
  // come from the serializer's derived transcriptPending.
  await page.goto(`/inbox?c=${conversationId}`);
  await expect(page.getByText("Transcribing…").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("the contact panel's Calls tab shows the same artifacts per row", async ({
  page,
}) => {
  await page.goto(`/inbox?c=${conversationId}`);
  await page.getByRole("button", { name: "Calls" }).first().click();

  // Two rows: the processed call offers its transcript…
  const rowTranscript = page.getByRole("button", { name: "Show transcript" }).last();
  await expect(rowTranscript).toBeVisible({ timeout: 15_000 });
  await rowTranscript.click();
  await expect(page.getByText(CUSTOMER_LINE).last()).toBeVisible();

  // …and the still-working call says so instead of showing nothing.
  await expect(page.getByText("Transcribing…").last()).toBeVisible();
});
