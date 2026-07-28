/**
 * Multi-account channel management.
 *
 * A workspace can hold several accounts on one channel (two WhatsApp numbers,
 * two Pages…). Two invariants matter more than the CRUD itself:
 *
 *   1. EXACTLY ONE default per (workspace, channel). Zero defaults means
 *      compose-new has nothing to send from; two means the choice is arbitrary
 *      and a customer can get a reply from a number they never messaged.
 *   2. Disconnecting an account must not silently re-route its live threads to
 *      a sibling number. Conversations survive with a NULL account (unsendable
 *      until rebound) rather than quietly changing which number replies.
 *
 *   pnpm --filter @ccp/api exec vitest run test/channel-accounts.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";

import { setSharedDb } from "@/lib/db";
import { NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChannelAccountsService } from "@/workspace-settings/channel-accounts/channel-accounts.service";
import type { DbService } from "@/db/db.service";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
// `remove()` reaches `gcOrphanWhatsappPortfolios`, which uses the MODULE-LEVEL
// shared client rather than the injected one — so this spec has to publish the
// connection or that call throws "lib/db.ts accessed before DbService booted".
setSharedDb(prisma as unknown as PrismaClient);

// The service publishes `team.catalog_changed` on rename/setDefault/remove so
// the app-wide account directory can't go stale; these specs assert the DB
// transitions, so a no-op bus is the whole dependency.
const bus = { publish: async () => undefined };
const service = new ChannelAccountsService(prisma as unknown as DbService, bus as never);

const S = `ca${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let accA = "";
let accB = "";

async function makeAccount(suffix: string, isDefault = false) {
  const row = await prisma.channelConnection.create({
    data: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: `${S}_${suffix}`,
      isDefault,
      config: { phoneNumberId: `${S}_${suffix}` },
      secrets: {},
    },
    select: { id: true },
  });
  return row.id;
}

const defaults = () =>
  prisma.channelConnection.findMany({
    where: { workspaceId, channel: "whatsapp", isDefault: true },
    select: { id: true },
  });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `CA ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `CA WS ${S}`, organizationId: orgId } })
  ).id;
  accA = await makeAccount("a", true);
  accB = await makeAccount("b");
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("list", () => {
  it("returns both accounts with the default first", async () => {
    const out = await service.list(workspaceId, "whatsapp");
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe(accA);
    expect(out[0]!.isDefault).toBe(true);
    expect(out[1]!.isDefault).toBe(false);
  });
});

describe("setDefault", () => {
  it("moves the default atomically — never zero, never two", async () => {
    await service.setDefault(workspaceId, "whatsapp", accB);
    const rows = await defaults();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(accB);
  });

  it("refuses an account from another workspace", async () => {
    const otherOrg = await prisma.organization.create({
      data: { name: `CA other ${S}`, status: "active" },
    });
    const otherWs = await prisma.workspace.create({
      data: { name: `CA other WS ${S}`, organizationId: otherOrg.id },
    });
    const foreign = await prisma.channelConnection.create({
      data: {
        workspaceId: otherWs.id,
        channel: "whatsapp",
        externalAccountId: `${S}_foreign`,
        config: {},
        secrets: {},
      },
      select: { id: true },
    });
    // Tenant boundary: an id from another workspace must not be selectable.
    await expect(
      service.setDefault(workspaceId, "whatsapp", foreign.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await prisma.organization.delete({ where: { id: otherOrg.id } });
  });
});

describe("remove", () => {
  it("promotes a successor when the DEFAULT account is disconnected", async () => {
    // accB is currently default; removing it must not leave the channel
    // with accounts but no default.
    await service.remove(workspaceId, "whatsapp", accB);
    const rows = await defaults();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(accA);
  });

  it("leaves conversations intact but UNBOUND rather than re-routing them", async () => {
    const extra = await makeAccount("c");
    const contact = await prisma.contact.create({
      data: {
        workspaceId,
        name: "CA contact",
        phoneNumber: `+9977${S}`,
        identityChannel: "whatsapp",
      },
      select: { id: true },
    });
    const convo = await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        channelConnectionId: extra,
      },
      select: { id: true },
    });

    await service.remove(workspaceId, "whatsapp", extra);

    const after = await prisma.conversation.findUnique({
      where: { id: convo.id },
      select: { id: true, channelConnectionId: true },
    });
    // Survives (history is never destroyed) but is NOT silently re-pointed at
    // accA — replying from a number the customer never messaged would break
    // thread affinity and the 24h window.
    expect(after).not.toBeNull();
    expect(after!.channelConnectionId).toBeNull();
  });
});
