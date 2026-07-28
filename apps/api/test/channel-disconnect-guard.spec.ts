/**
 * The CHANNEL-level disconnect refuses to silently remove several accounts.
 *
 * `DELETE /api/workspace/{whatsapp,messenger,instagram}` deletes EVERY
 * `ChannelConnection` on the channel. Both account pointers are
 * `onDelete: SetNull`, so it strands every thread on the channel (the next
 * reply fails `account-unresolved`) and nulls the sender of every scheduled
 * campaign. The per-account `remove()` has had a `removalImpact` preflight
 * since multi-account shipped; this route is strictly more destructive and had
 * none — and on Messenger/Instagram the confirm copy didn't even say "all".
 *
 * Single-account workspaces — i.e. every workspace before this feature — are
 * deliberately unaffected: one account is unambiguous and passes untouched.
 *
 *   pnpm --filter @ccp/api exec vitest run test/channel-disconnect-guard.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { assertChannelDisconnectConfirmed } from "@/lib/providers/assert-channel-disconnect";
import { ChannelAccountsService } from "@/workspace-settings/channel-accounts/channel-accounts.service";
import type { DbService } from "@/db/db.service";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);
// The service publishes `team.catalog_changed` on rename/setDefault/remove so
// the app-wide account directory can't go stale; these specs assert the DB
// transitions, so a no-op bus is the whole dependency.
const bus = { publish: async () => undefined };
const accounts = new ChannelAccountsService(prisma as unknown as DbService, bus as never);

const S = `dc${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let accountAId = "";

async function mkAccount(suffix: string, isDefault: boolean) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_${suffix}`,
        isDefault,
        isActive: true,
        config: { phoneNumberId: `${S}_${suffix}` },
        secrets: {},
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `DC Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `DC WS ${S}`, organizationId: orgId } })
  ).id;
  accountAId = await mkAccount("a", true);
});

beforeEach(async () => {
  // Reset to exactly ONE account; individual tests add the second.
  await prisma.channelConnection.deleteMany({
    where: { workspaceId, channel: "whatsapp", id: { not: accountAId } },
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("channel disconnect guard", () => {
  it("allows an unconfirmed disconnect with ONE account", async () => {
    // The pre-multi-account experience must be byte-identical.
    await expect(
      assertChannelDisconnectConfirmed(workspaceId, "whatsapp", undefined),
    ).resolves.toBeUndefined();
  });

  it("REFUSES an unconfirmed disconnect with two accounts", async () => {
    await mkAccount("b", false);
    await expect(
      assertChannelDisconnectConfirmed(workspaceId, "whatsapp", undefined),
    ).rejects.toMatchObject({
      response: { error: "multiple_accounts_confirm_required", accounts: 2 },
    });
  });

  it("allows it once explicitly confirmed", async () => {
    await mkAccount("b", false);
    await expect(
      assertChannelDisconnectConfirmed(workspaceId, "whatsapp", true),
    ).resolves.toBeUndefined();
  });

  it("allows a channel with NO accounts (disconnect is a no-op)", async () => {
    await expect(
      assertChannelDisconnectConfirmed(workspaceId, "messenger", undefined),
    ).resolves.toBeUndefined();
  });
});

describe("channelRemovalImpact", () => {
  it("counts every account's threads and campaigns, not just the default's", async () => {
    const accountBId = await mkAccount("b", false);
    const contact = await prisma.contact.create({
      data: {
        workspaceId,
        identityChannel: "whatsapp",
        phoneNumber: `${Date.now()}`.slice(-11),
        name: "DC Contact",
      },
      select: { id: true },
    });
    // The thread lives on the NON-default account — the exact row a
    // default-scoped preflight would have missed.
    await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        channelConnectionId: accountBId,
        status: "open",
        lastMessageAt: new Date(),
      },
    });

    const impact = await accounts.channelRemovalImpact(workspaceId, "whatsapp");
    expect(impact.accounts).toBe(2);
    expect(impact.conversations).toBe(1);
    expect(impact.openConversations).toBe(1);
  });

  it("reports zeros for a channel with nothing connected", async () => {
    expect(await accounts.channelRemovalImpact(workspaceId, "instagram")).toEqual({
      accounts: 0,
      conversations: 0,
      openConversations: 0,
      scheduledBroadcasts: 0,
    });
  });
});
