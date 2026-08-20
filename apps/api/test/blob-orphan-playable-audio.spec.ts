/**
 * Blob-orphan sweeper × the playable-audio cache (lib/media/playable-audio.ts).
 *
 * `<key>.m4a` is the lazily-transcoded AAC shadow of a stored ogg/webm audio
 * object — deliberately referenced by NO database column, because it is a
 * cache. Without its rule in the sweeper, every variant would be reclaimed 24h
 * after first play and silently re-transcoded on the next one, forever. The
 * rule: a `<base>.m4a` key is live exactly while `<base>` is referenced; when
 * the base row dies, the variant is an orphan and is collected WITH it.
 *
 *   pnpm --filter @ccp/api exec vitest run test/blob-orphan-playable-audio.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

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

const SUFFIX = `pa${Date.now().toString().slice(-8)}`;
const OLD = Date.now() - 48 * 60 * 60 * 1000;

let organizationId: string;
let workspaceId: string;

const liveVoiceKey = `media/${SUFFIX}/voice.ogg`;
const liveVariantKey = `${liveVoiceKey}.m4a`;
const deadVariantKey = `media/${SUFFIX}/deleted-voice.ogg.m4a`;

beforeAll(async () => {
  const org = await db.organization.create({
    data: { name: `playable-audio-org-${SUFFIX}`, status: "active" },
  });
  organizationId = org.id;
  const ws = await db.workspace.create({
    data: { name: `playable-audio-${SUFFIX}`, organizationId },
  });
  workspaceId = ws.id;
  const contact = await db.contact.create({
    data: {
      workspaceId,
      name: `Playable ${SUFFIX}`,
      phoneNumber: `1666${SUFFIX.slice(-7)}`,
      identityChannel: "whatsapp",
    },
  });
  const conversation = await db.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp" },
  });
  await db.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      channel: "whatsapp",
      direction: "in",
      externalId: `wamid.${SUFFIX}`,
      body: "",
      timestamp: new Date(),
      mediaKey: liveVoiceKey,
      mediaKind: "audio",
      mediaMimeType: "audio/ogg",
    },
  });

  listed.push(
    { key: liveVoiceKey, uploadedAt: OLD },
    // The cache variant of the LIVE voice note — referenced by no column.
    { key: liveVariantKey, uploadedAt: OLD },
    // A variant whose base message is long gone — a true orphan.
    { key: deadVariantKey, uploadedAt: OLD },
  );
});

afterAll(async () => {
  if (!organizationId) return;
  await db.message.deleteMany({ where: { workspaceId } });
  await db.conversation.deleteMany({ where: { workspaceId } });
  await db.contact.deleteMany({ where: { workspaceId } });
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.organization.deleteMany({ where: { id: organizationId } });
});

describe("blob-orphan sweeper × playable-audio variants", () => {
  it("keeps a variant whose base key is still referenced", async () => {
    await sweepBlobOrphansOnce();
    expect(deleted).not.toContain(liveVoiceKey);
    expect(deleted).not.toContain(liveVariantKey);
  });

  it("reclaims a variant whose base is gone", async () => {
    // Negative half — proves the rule keys off the BASE's liveness rather than
    // whitelisting every .m4a forever.
    expect(deleted).toContain(deadVariantKey);
  });
});
