/**
 * In-app call recording storage — the browser-upload half of the "inapp"
 * artifact mode, driven against the REAL database and blob storage.
 *
 * Pins the production-grade guarantees of `storeInAppRecording`:
 *   - an interim flush stores the raw browser container and stamps the row,
 *     so a crash mid-call still leaves audio behind;
 *   - the final upload survives an ffmpeg remux FAILURE (these bytes are not
 *     real audio) by keeping the raw container — a recording that only plays
 *     in Chrome beats no recording;
 *   - the stored bytes round-trip EXACTLY (delivered-artifact assertion);
 *   - transcription is skipped quietly when the workspace has no AI config
 *     (the recording must still be stored).
 *
 *   pnpm --filter @ccp/api exec vitest run test/inapp-recording.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

import { storeInAppRecording } from "@/lib/media/call-recording-download";
import { blobStorage } from "@/lib/blob-storage";

const S = `iar${Date.now().toString().slice(-8)}`;

let orgId = "";
let workspaceId = "";
let callId = "";
const storedKeys: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `IAR Org ${S}`, status: "active" },
  });
  orgId = org.id;
  workspaceId = (
    await prisma.workspace.create({
      data: { name: `IAR WS ${S}`, organizationId: orgId },
    })
  ).id;
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: "IAR Contact",
      identityChannel: "whatsapp",
      phoneNumber: `9613${Date.now().toString().slice(-6)}`,
    },
  });
  const conversation = await prisma.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp", status: "open" },
  });
  callId = (
    await prisma.call.create({
      data: {
        workspaceId,
        conversationId: conversation.id,
        externalCallId: `${S}_call`,
        direction: "out",
        status: "completed",
        ringingAt: new Date(),
        answeredAt: new Date(),
        endedAt: new Date(),
        durationSeconds: 30,
        rawPayload: {},
      },
    })
  ).id;
});

afterAll(async () => {
  await blobStorage.delete(storedKeys).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("storeInAppRecording", () => {
  const interimBytes = new TextEncoder().encode(`WEBM_INTERIM_${S}`);
  const finalBytes = new TextEncoder().encode(`WEBM_FINAL_${S}_${"x".repeat(64)}`);

  it("interim flush stores the raw container and stamps the row (crash resilience)", async () => {
    await storeInAppRecording(
      callId,
      { bytes: interimBytes, mimeType: "audio/webm" },
      { final: false, transcribe: false },
    );
    const row = await prisma.call.findUnique({
      where: { id: callId },
      select: { recordingKey: true, recordingMimeType: true },
    });
    expect(row?.recordingKey).toBe(`call-recordings/${workspaceId}/${callId}.raw`);
    expect(row?.recordingMimeType).toBe("audio/webm");
    storedKeys.push(row!.recordingKey!);
    const fetched = await blobStorage.fetch(row!.recordingKey!);
    expect(Buffer.from(fetched.bytes).equals(Buffer.from(interimBytes))).toBe(true);
  });

  it("final upload survives a remux failure, replaces the interim bytes exactly, and skips transcription without AI config", async () => {
    // These bytes are not decodable audio, so the ffmpeg remux FAILS (or
    // ffmpeg is absent entirely) — the fallback path must still store the
    // browser container verbatim. transcribe:true exercises the AI-config
    // gate: this workspace has none, so transcription is skipped quietly.
    await storeInAppRecording(
      callId,
      { bytes: finalBytes, mimeType: "audio/webm" },
      { final: true, transcribe: true },
    );
    const row = await prisma.call.findUnique({
      where: { id: callId },
      select: { recordingKey: true, transcriptKey: true },
    });
    expect(row?.recordingKey).not.toBeNull();
    storedKeys.push(row!.recordingKey!);
    const fetched = await blobStorage.fetch(row!.recordingKey!);
    // Delivered-artifact assertion: the stored file IS the final upload —
    // byte-identical, and no longer the interim flush.
    expect(Buffer.from(fetched.bytes).equals(Buffer.from(finalBytes))).toBe(true);
    // Give the detached transcription a beat, then assert it declined to run
    // (no AI config) rather than crashing or writing a bogus transcript.
    await new Promise((r) => setTimeout(r, 1_500));
    const after = await prisma.call.findUnique({
      where: { id: callId },
      select: { transcriptKey: true },
    });
    expect(after?.transcriptKey).toBeNull();
  });
});
