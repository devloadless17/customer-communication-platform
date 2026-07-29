/**
 * Workspace delete must reclaim the AI blobs — because NOTHING ELSE CAN.
 *
 * Every other blob category has two chances: the delete path collects its keys,
 * and if that misses, the blob-orphan sweeper reclaims them later by
 * cross-checking the column that holds the key.
 *
 * `ai-knowledge/` and `ai-voice-draft/` have exactly one. Their keys live in
 * `AiContextDocument.r2Key` and `AiReplySuggestion.audioR2Key`, which the
 * sweeper does not cross-check — so both prefixes sit in its
 * `URL_ONLY_KEY_PREFIXES` exclusion list, and it is FORBIDDEN to touch them.
 * That exclusion is correct for the live case (without it the sweeper would
 * classify every live document as an orphan and delete it) and it is exactly
 * what stranded them on delete: the cascade takes the rows, the sweeper looks
 * away, and the objects leak forever. A churned tenant's uploaded knowledge
 * base — up to the documented 10 MB × 50 doc cap — stays in the bucket
 * permanently.
 *
 * So this asserts the collector directly. It is the only reclaim path, which is
 * why it gets its own spec rather than being folded into a broader delete test.
 *
 *   pnpm --filter @ccp/api exec vitest run test/workspace-destroy-ai-blobs.spec.ts
 */
import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspaceRootService } from "@/workspace-settings/workspace-root.service";
import type { DbService } from "@/db/db.service";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

/** The private collector, named rather than double-asserted. */
interface CollectorSurface {
  collectAiArtifactKeys(workspaceId: string): Promise<string[]>;
}

const S = `wdai${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let docKey = "";
let draftKey = "";

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `WDAI Org ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `WDAI WS ${S}`, organizationId: orgId } })
  ).id;

  docKey = `ai-knowledge/${workspaceId}/${S}-doc`;
  await prisma.aiContextDocument.create({
    data: {
      workspaceId,
      filename: `knowledge-${S}.pdf`,
      r2Key: docKey,
      mimeType: "application/pdf",
      sizeBytes: 1234,
    },
  });

  // A voice draft hangs off a real inbound message, same as in production.
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `WDAI Contact ${S}`,
      phoneNumber: `1888${S.slice(-7)}`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  const conv = await prisma.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  const msg = await prisma.message.create({
    data: {
      workspaceId,
      conversationId: conv.id,
      externalId: `wamid.${S}.ai`,
      body: "voice draft probe",
      direction: "in",
      channel: "whatsapp",
    },
    select: { id: true },
  });
  draftKey = `ai-voice-draft/${workspaceId}/${msg.id}.mp3`;
  await prisma.aiReplySuggestion.create({
    data: {
      workspaceId,
      conversationId: conv.id,
      inboundMessageId: msg.id,
      text: "drafted reply",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      audioR2Key: draftKey,
    },
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("workspace destroy — AI artifact keys", () => {
  it("collects BOTH the knowledge doc and the voice draft", async () => {
    const svc = new WorkspaceRootService(
      prisma as unknown as DbService,
    ) as unknown as CollectorSurface;

    const keys = await svc.collectAiArtifactKeys(workspaceId);

    expect(keys).toContain(docKey);
    expect(keys).toContain(draftKey);
  });

  it("does not reach into another workspace's AI blobs", async () => {
    // Tenancy, on a path that takes a workspaceId and deletes real objects.
    const otherWs = await prisma.workspace.create({
      data: { name: `WDAI Other ${S}`, organizationId: orgId },
      select: { id: true },
    });
    const svc = new WorkspaceRootService(
      prisma as unknown as DbService,
    ) as unknown as CollectorSurface;

    const keys = await svc.collectAiArtifactKeys(otherWs.id);

    expect(keys).not.toContain(docKey);
    expect(keys).not.toContain(draftKey);
    expect(keys).toHaveLength(0);
  });
});
