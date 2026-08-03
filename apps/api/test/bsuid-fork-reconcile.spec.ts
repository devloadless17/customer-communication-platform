/**
 * BSUID cold-fork reconciliation + the number-change trio reset.
 *
 * A BSUID-only inbound outside the 30-day wa_id window forks a person into a
 * second contact + thread. The ONLY join opportunity Meta grants is a webhook
 * carrying BOTH keys; `reconcileBsuidFork` spends it:
 *
 *   - the phone-bearing winner gets the trio (bsuid, parentBsuid, portfolio
 *     stamp), the fork's trio is nulled so the next bsuid-keyed webhook
 *     resolves to the survivor, and both contacts are linked through ONE
 *     Customer — threads are NEVER merged;
 *   - a winner already holding a DIFFERENT bsuid keeps its keys (likely a
 *     sibling portfolio's id for the same person) but the Customer link is
 *     still made;
 *   - two established Customers → stand down on the link (manual-merge
 *     territory — the auto-fold bug class two audits caught).
 *
 * And `contact_number_change` nulls the whole trio: Meta REGENERATES BSUIDs on
 * a number change, so the stored id is dead the moment the number moves.
 *
 *   pnpm --filter @ccp/api exec vitest run test/bsuid-fork-reconcile.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { seedWabaAccount } from "./_waba";

vi.mock("@/lib/events/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/bus")>();
  return { ...actual, publish: vi.fn(async () => undefined) };
});

import { metaProvider } from "@/lib/providers/meta";
import { reconcileBsuidFork } from "@/lib/identity/bsuid-reconcile";
import { ingestWithRedelivery } from "./_ingest-redelivery";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `bsf${Date.now().toString().slice(-8)}`;
const PN = `${S}_pn_a`;

let orgId = "";
let workspaceId = "";
let portfolioA = "";
let connA = "";

function envelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: `${S}_waba_a`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: PN },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

async function makeContact(overrides: {
  phone?: string;
  bsuid?: string | null;
  customerId?: string | null;
  withConversation?: boolean;
}): Promise<{ id: string; conversationId: string | null }> {
  const row = await prisma.contact.create({
    data: {
      workspaceId,
      name: `Fork ${overrides.phone ?? overrides.bsuid ?? "x"}`,
      identityChannel: "whatsapp",
      phoneNumber: overrides.phone ?? null,
      bsuid: overrides.bsuid ?? null,
      ...(overrides.customerId ? { customerId: overrides.customerId } : {}),
    },
    select: { id: true },
  });
  let conversationId: string | null = null;
  if (overrides.withConversation) {
    conversationId = (
      await prisma.conversation.create({
        data: { workspaceId, contactId: row.id, channel: "whatsapp", channelConnectionId: connA },
        select: { id: true },
      })
    ).id;
  }
  return { id: row.id, conversationId };
}

async function contactRow(id: string) {
  return prisma.contact.findUniqueOrThrow({
    where: { id },
    select: {
      phoneNumber: true,
      bsuid: true,
      parentBsuid: true,
      bsuidPortfolioId: true,
      customerId: true,
    },
  });
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `Fork Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `Fork WS ${S}`, organizationId: orgId } })
  ).id;
  portfolioA = (
    await prisma.whatsappPortfolio.create({ data: { workspaceId }, select: { id: true } })
  ).id;
  connA = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: PN,
        isDefault: true,
        isActive: true,
        wabaAccountId: await seedWabaAccount(prisma, workspaceId, `${S}_waba_a`, {
          portfolioId: portfolioA,
        }),
        config: { phoneNumberId: PN, displayPhoneNumber: "+1 555-020-0001" },
        secrets: {},
        messagingHealthUpdatedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("reconcileBsuidFork", () => {
  it("moves the trio to the phone-bearing winner, nulls the fork, links ONE Customer, merges NO threads", async () => {
    const winner = await makeContact({ phone: `961${S.replace(/\D/g, "")}11`, withConversation: true });
    const fork = await makeContact({ bsuid: "LB.F1", withConversation: true });

    await reconcileBsuidFork(workspaceId, "whatsapp", winner.id, {
      bsuid: "LB.F1",
      parentBsuid: "US.ENT.F1",
      channelConnectionId: connA,
    });

    const w = await contactRow(winner.id);
    expect(w.bsuid).toBe("LB.F1");
    expect(w.parentBsuid).toBe("US.ENT.F1");
    expect(w.bsuidPortfolioId).toBe(portfolioA);

    const f = await contactRow(fork.id);
    expect(f.bsuid).toBeNull();
    expect(f.parentBsuid).toBeNull();
    expect(f.bsuidPortfolioId).toBeNull();

    // One person: both contacts point at the SAME Customer.
    expect(w.customerId).toBeTruthy();
    expect(f.customerId).toBe(w.customerId);

    // Threads are never merged — both conversations survive, each still
    // pointing at its own contact.
    const convs = await prisma.conversation.findMany({
      where: { workspaceId, contactId: { in: [winner.id, fork.id] } },
      select: { id: true, contactId: true },
    });
    expect(convs).toHaveLength(2);
    expect(convs.find((c) => c.id === winner.conversationId)?.contactId).toBe(winner.id);
    expect(convs.find((c) => c.id === fork.conversationId)?.contactId).toBe(fork.id);
  });

  it("keeps a winner's DIFFERENT stored bsuid untouched but still makes the Customer link", async () => {
    const customer = await prisma.customer.create({
      data: { workspaceId, name: "Fork holder" },
      select: { id: true },
    });
    const winner = await makeContact({
      phone: `961${S.replace(/\D/g, "")}12`,
      bsuid: "LB.SIBLING12",
    });
    const fork = await makeContact({ bsuid: "LB.F2", customerId: customer.id });

    await reconcileBsuidFork(workspaceId, "whatsapp", winner.id, {
      bsuid: "LB.F2",
      parentBsuid: null,
      channelConnectionId: connA,
    });

    const w = await contactRow(winner.id);
    // The stored key is likely a sibling portfolio's id for the same person —
    // overwriting it would discard a valid key.
    expect(w.bsuid).toBe("LB.SIBLING12");
    // The link is still made, adopting the fork's existing Customer.
    expect(w.customerId).toBe(customer.id);
    expect((await contactRow(fork.id)).customerId).toBe(customer.id);
  });

  it("is a no-op when nobody else holds the bsuid (the overwhelmingly common case)", async () => {
    const winner = await makeContact({ phone: `961${S.replace(/\D/g, "")}13` });
    await reconcileBsuidFork(workspaceId, "whatsapp", winner.id, {
      bsuid: "LB.NOBODY13",
      parentBsuid: null,
      channelConnectionId: connA,
    });
    const w = await contactRow(winner.id);
    // The fork reconcile itself stamps nothing on a no-fork call — tx1's
    // fill-a-NULL backfill owns that write on the ingest path.
    expect(w.bsuid).toBeNull();
    expect(w.customerId).toBeNull();
  });

  it("stands down on the Customer link when both sides are ESTABLISHED customers", async () => {
    const custA = await prisma.customer.create({
      data: { workspaceId, name: "A" },
      select: { id: true },
    });
    const custB = await prisma.customer.create({
      data: { workspaceId, name: "B" },
      select: { id: true },
    });
    const winner = await makeContact({
      phone: `961${S.replace(/\D/g, "")}14`,
      customerId: custA.id,
    });
    const fork = await makeContact({ bsuid: "LB.F4", customerId: custB.id });

    await reconcileBsuidFork(workspaceId, "whatsapp", winner.id, {
      bsuid: "LB.F4",
      parentBsuid: null,
      channelConnectionId: connA,
    });

    // Folding two established profiles is a human's call — nothing moved.
    expect((await contactRow(winner.id)).customerId).toBe(custA.id);
    expect((await contactRow(fork.id)).customerId).toBe(custB.id);
  });
});

describe("ingest end-to-end: the dual-key webhook heals the fork", () => {
  it("resolves by phone, re-keys the bsuid off the fork, and leaves both threads intact", async () => {
    const phone = `961${S.replace(/\D/g, "")}21`;
    const winner = await makeContact({ phone, withConversation: true });
    const fork = await makeContact({ bsuid: "LB.E2E", withConversation: true });

    const events = metaProvider.parseWebhook(
      envelope({
        contacts: [
          { profile: { name: "Grace" }, wa_id: phone, user_id: "LB.E2E" },
        ],
        messages: [
          {
            from: phone,
            from_user_id: "LB.E2E",
            id: `wamid.${S}_DUAL1`,
            timestamp: "1785400000",
            type: "text",
            text: { body: "back inside the 30-day window" },
          },
        ],
      }),
    );
    await ingestWithRedelivery(workspaceId, "whatsapp", events, connA);

    // The reconcile is fire-and-forget post-commit — converge on it.
    //
    // Wait for the LAST write it makes, not the first. `reconcileBsuidFork`
    // nulls the fork's bsuid and only then calls `linkContactsViaCustomer`, so
    // waiting on the bsuid alone returns while the Customer link is still in
    // flight — and the customerId assertions below then read a row that is
    // half-written. Flaky on a loaded runner, green on a fast one.
    await waitFor(
      async () =>
        (await contactRow(fork.id)).bsuid === null &&
        (await contactRow(winner.id)).customerId !== null,
      "the fork's bsuid to be re-keyed and both contacts linked",
    );

    const w = await contactRow(winner.id);
    expect(w.bsuid).toBe("LB.E2E");
    expect(w.customerId).toBeTruthy();
    expect((await contactRow(fork.id)).customerId).toBe(w.customerId);

    // The message landed on the WINNER's thread; the fork's thread survives.
    const msg = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `wamid.${S}_DUAL1` },
      select: { conversation: { select: { contactId: true } } },
    });
    expect(msg.conversation.contactId).toBe(winner.id);
    const convs = await prisma.conversation.findMany({
      where: { workspaceId, contactId: { in: [winner.id, fork.id] } },
      select: { id: true },
    });
    expect(convs).toHaveLength(2);
  });
});

describe("contact_number_change clears the BSUID trio", () => {
  it("re-points the phone and nulls bsuid/parentBsuid/portfolio (Meta regenerates them)", async () => {
    const oldPhone = `961${S.replace(/\D/g, "")}31`;
    const newPhone = `961${S.replace(/\D/g, "")}32`;
    const contact = await prisma.contact.create({
      data: {
        workspaceId,
        name: "Mover",
        identityChannel: "whatsapp",
        phoneNumber: oldPhone,
        bsuid: "LB.MOVER",
        parentBsuid: "US.ENT.MOVER",
        bsuidPortfolioId: portfolioA,
      },
      select: { id: true },
    });

    const events = metaProvider.parseWebhook(
      envelope({
        contacts: [{ profile: { name: "Mover" }, wa_id: oldPhone }],
        messages: [
          {
            from: oldPhone,
            id: `wamid.${S}_NC1`,
            timestamp: "1785400000",
            type: "system",
            system: { type: "user_changed_number", wa_id: newPhone, body: "changed number" },
          },
        ],
      }),
    );
    expect(events.some((e) => e.kind === "contact_number_change")).toBe(true);
    // Number-change ingest is awaited inside ingestEvents — deterministic.
    await ingestWithRedelivery(workspaceId, "whatsapp", events, connA);

    const row = await contactRow(contact.id);
    expect(row.phoneNumber).toBe(newPhone);
    expect(row.bsuid).toBeNull();
    expect(row.parentBsuid).toBeNull();
    expect(row.bsuidPortfolioId).toBeNull();
  });
});
