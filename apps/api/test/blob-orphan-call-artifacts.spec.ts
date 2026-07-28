/**
 * Blob-orphan sweeper — the cross-check must cover EVERY column that persists
 * an R2 object key.
 *
 * This sweeper walks the whole bucket and deletes any object older than the
 * grace window whose key it cannot find in the database. That makes its failure
 * mode permanent deletion of live customer data, and the miss is silent from
 * both ends: the row keeps advertising a key, and the sweeper logs a reclaim
 * count that looks like healthy housekeeping.
 *
 * It has been missed four times (avatars, ai-knowledge, ai-voice-draft, contact
 * import/export — each documented in the sweeper's header). The fourth was CALL
 * ARTIFACTS: `call-recordings/{ws}/{callId}.ogg` and
 * `call-transcripts/{ws}/{callId}.json` are referenced only by
 * `Call.recordingKey` / `Call.transcriptKey`, which the cross-check did not
 * query and the exclusion list did not name. Every recording was therefore
 * deleted 24h after the call — and unrecoverably, because Meta drops its own
 * copy 7 days in, so R2 held the only one.
 *
 * The test drives the real `sweepBlobOrphansOnce` against a stubbed provider
 * listing: one referenced key per column (which must SURVIVE) and one
 * unreferenced key (which must be reclaimed, proving the sweeper still does its
 * job rather than passing because it deleted nothing).
 *
 *   pnpm --filter @ccp/api exec vitest run test/blob-orphan-call-artifacts.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

// Stub the provider BEFORE the sweeper module is imported: it captures
// `blobStorage` at module scope.
const listed: { key: string; uploadedAt: number }[] = [];
const deleted: string[] = [];

vi.mock("@/lib/blob-storage", () => ({
  blobStorage: {
    name: "stub",
    listKeys: async () => ({ keys: listed, nextCursor: undefined }),
    delete: async (keys: string[]) => {
      deleted.push(...keys);
    },
  },
}));

const { db, setSharedDb } = await import("@/lib/db");
const { sweepBlobOrphansOnce } = await import("@/lib/sweepers/blob-orphan");

setSharedDb(createTestPrismaClient() as unknown as PrismaClient);

const SUFFIX = `bo${Date.now().toString().slice(-8)}`;
// Older than the sweeper's 24h grace window, so every key is eligible.
const OLD = Date.now() - 48 * 60 * 60 * 1000;

let organizationId: string;
let workspaceId: string;
let contactId: string;
let conversationId: string;

const recordingKey = `call-recordings/ws-${SUFFIX}/call-${SUFFIX}.ogg`;
const transcriptKey = `call-transcripts/ws-${SUFFIX}/call-${SUFFIX}.json`;
const messageMediaKey = `media/${SUFFIX}/msg.jpg`;
const genuineOrphanKey = `media/${SUFFIX}/nobody-references-this.jpg`;

beforeAll(async () => {
  const org = await db.organization.create({
    data: { name: `blob-orphan-org-${SUFFIX}`, status: "active" },
  });
  organizationId = org.id;
  const ws = await db.workspace.create({
    data: { name: `blob-orphan-${SUFFIX}`, organizationId },
  });
  workspaceId = ws.id;

  const contact = await db.contact.create({
    data: {
      workspaceId,
      name: `Blob Orphan ${SUFFIX}`,
      phoneNumber: `1555${SUFFIX.slice(-7)}`,
      identityChannel: "whatsapp",
    },
  });
  contactId = contact.id;
  const conversation = await db.conversation.create({
    data: { workspaceId, contactId, channel: "whatsapp" },
  });
  conversationId = conversation.id;

  // A message whose media key IS referenced — the family the sweeper already
  // covered, kept here so a regression in the existing check fails too.
  await db.message.create({
    data: {
      workspaceId,
      conversationId,
      channel: "whatsapp",
      direction: "in",
      externalId: `wamid.${SUFFIX}`,
      body: "",
      timestamp: new Date(),
      mediaKey: messageMediaKey,
      mediaKind: "image",
    },
  });

  // The call artifacts — recording and transcript downloaded to R2.
  await db.call.create({
    data: {
      workspaceId,
      conversationId,
      channel: "whatsapp",
      externalCallId: `call.${SUFFIX}`,
      direction: "in",
      status: "completed",
      ringingAt: new Date(),
      rawPayload: {},
      recordingKey,
      transcriptKey,
    },
  });

  listed.push(
    { key: recordingKey, uploadedAt: OLD },
    { key: transcriptKey, uploadedAt: OLD },
    { key: messageMediaKey, uploadedAt: OLD },
    { key: genuineOrphanKey, uploadedAt: OLD },
  );
});

afterAll(async () => {
  if (!organizationId) return;
  await db.call.deleteMany({ where: { workspaceId } });
  await db.message.deleteMany({ where: { workspaceId } });
  await db.conversation.deleteMany({ where: { workspaceId } });
  await db.contact.deleteMany({ where: { workspaceId } });
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.organization.deleteMany({ where: { id: organizationId } });
});

describe("blob-orphan sweeper", () => {
  it("never reclaims a key a database column still references", async () => {
    await sweepBlobOrphansOnce();

    // The whole point: a referenced call recording/transcript is not an orphan.
    // Before the fix both of these were in `deleted`, and the bytes were gone
    // for good.
    expect(deleted).not.toContain(recordingKey);
    expect(deleted).not.toContain(transcriptKey);
    expect(deleted).not.toContain(messageMediaKey);
  });

  it("still reclaims a genuinely unreferenced key", async () => {
    // Negative half — without this the test above would pass just as well if
    // the sweeper deleted nothing at all.
    expect(deleted).toContain(genuineOrphanKey);
  });
});
