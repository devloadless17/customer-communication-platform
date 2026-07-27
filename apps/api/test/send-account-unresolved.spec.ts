/**
 * A thread whose account was disconnected must NOT fall back to the default.
 *
 * The §2 invariant — "a reply always goes out the account the customer
 * messaged" — was fixed at five send paths in B-M3 session 2, and then quietly
 * undone at the FK layer: `Conversation.channelConnectionId` and
 * `Broadcast.channelConnectionId` are both `onDelete: SetNull`, so
 * disconnecting a number NULLS every thread and campaign bound to it. The send
 * paths faithfully passed that null through, and `loadSendCipher` treated a
 * null account as "use `isDefault: true`".
 *
 * Net effect: after an admin disconnected number A, every reply on A's threads
 * went out from number B — a sender the customer never messaged, with no 24h
 * window there — and a scheduled campaign bound to A sent its whole audience
 * from B. `channel-accounts.service.remove()`'s own docstring promised the
 * opposite, and `removalImpact` showed the admin a count under that false
 * premise.
 *
 * The guard: an unresolved account is refused when the workspace has MORE THAN
 * ONE active account on that channel. With exactly one the fallback is
 * genuinely unambiguous and stays (that is the overwhelmingly common shape, so
 * this must not regress it). The state is self-healing either way — ingest
 * re-stamps a thread's account on the next inbound.
 */
import { existsSync } from "node:fs";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getMetaSendConfig, invalidateProviderConfig } from "@/lib/providers/config";
import { setSharedDb } from "@/lib/db";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
setSharedDb(prisma as unknown as PrismaClient);

const ORG_ID = "e2e-sendacct-org";
const WS_ID = "e2e-sendacct-ws";

/** A connection complete enough that resolution succeeds when it is chosen. */
async function makeAccount(name: string, isDefault: boolean): Promise<string> {
  const row = await prisma.channelConnection.create({
    data: {
      workspaceId: WS_ID,
      channel: "whatsapp",
      externalAccountId: `acct-${name}-${Date.now()}`,
      label: name,
      isActive: true,
      isDefault,
      config: { phoneNumberId: `pn-${name}`, wabaId: `waba-${name}` },
      secrets: {},
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  await prisma.organization.upsert({
    where: { id: ORG_ID },
    create: { id: ORG_ID, name: "Send Acct Org", status: "active" },
    update: {},
  });
  await prisma.workspace.upsert({
    where: { id: WS_ID },
    create: { id: WS_ID, name: "Send Acct WS", organizationId: ORG_ID },
    update: {},
  });
});

beforeEach(async () => {
  await prisma.channelConnection.deleteMany({ where: { workspaceId: WS_ID } });
  invalidateProviderConfig(WS_ID);
});

afterAll(async () => {
  await prisma.channelConnection.deleteMany({ where: { workspaceId: WS_ID } });
  await prisma.workspace.deleteMany({ where: { id: WS_ID } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  await prisma.$disconnect();
});

describe("send-account resolution when the thread's account is gone", () => {
  /**
   * Resolution can fail for two very different reasons, and only one of them
   * is this guard: `account-unresolved` (we refuse to guess which number) vs
   * missing credentials on the account we DID pick. The fixtures here carry
   * no real encrypted secrets, so the happy paths still reject — asserting on
   * WHICH reason is what actually proves the guard, and it keeps the test
   * honest without minting live credentials.
   */
  const reasonOf = async (accountId: string | null): Promise<string> => {
    try {
      await getMetaSendConfig(WS_ID, accountId);
      return "resolved";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  it("REFUSES an unresolved account when the workspace has several", async () => {
    await makeAccount("alpha", true);
    await makeAccount("beta", false);

    // No account id = what a thread looks like after its own account was
    // disconnected (SetNull). Resolving this to `alpha` would message the
    // customer from a number they never wrote to.
    expect(await reasonOf(null)).toMatch(/account-unresolved/);
  });

  it("does NOT refuse the single-account case — the common shape must not break", async () => {
    await makeAccount("solo", true);
    // It gets past the ambiguity guard and on to the real config check; the
    // ONLY thing this asserts is that it is not refused for ambiguity.
    expect(await reasonOf(null)).not.toMatch(/account-unresolved/);
  });

  it("does NOT refuse when the thread NAMES its account, even with siblings", async () => {
    await makeAccount("alpha", true);
    const beta = await makeAccount("beta", false);
    // The whole point of the §2 fix: a named non-default account resolves.
    expect(await reasonOf(beta)).not.toMatch(/account-unresolved/);
  });

  it("counts only ACTIVE siblings — a deactivated one leaves no ambiguity", async () => {
    await makeAccount("alpha", true);
    const beta = await makeAccount("beta", false);
    await prisma.channelConnection.update({
      where: { id: beta },
      data: { isActive: false },
    });
    invalidateProviderConfig(WS_ID);
    expect(await reasonOf(null)).not.toMatch(/account-unresolved/);
  });
});
