/**
 * Halting campaigns when Meta pauses their template.
 *
 * Meta's instruction is explicit: when a template is paused, "halt any automated
 * messaging campaigns that rely on that template" — the API rejects the sends
 * anyway. We already had a breaker for this, but it is REACTIVE: it needs
 * PERMANENT_ERROR_PAUSE_THRESHOLD consecutive send failures before it trips, so
 * it burns that many recipients into `failed` first, and only fires if the
 * campaign happens to be mid-send. A `scheduled` campaign sails past it entirely
 * and fires later into a template that cannot send.
 *
 * The status webhook is the proactive signal, which is what this covers.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-pause-halt.spec.ts
 */
import { existsSync } from "node:fs";

import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { seedWabaAccount } from "./_waba";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

const S = `tp${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let templateId = "";

// The runner re-fires resumed broadcasts. Stub that so the test asserts the
// STATE TRANSITIONS rather than booting a send loop with no Meta behind it.
vi.mock("@/lib/queues", () => ({
  getQueue: () => ({ add: async () => undefined }),
  QUEUE_NAMES: { broadcasts: "broadcasts" },
}));

let pauseBroadcastsForTemplate: typeof import("@/lib/broadcast-runner")["pauseBroadcastsForTemplate"];
let resumeBroadcastsForTemplate: typeof import("@/lib/broadcast-runner")["resumeBroadcastsForTemplate"];

beforeAll(async () => {
  setSharedDb(prisma as unknown as Parameters<typeof setSharedDb>[0]);
  ({ pauseBroadcastsForTemplate, resumeBroadcastsForTemplate } = await import(
    "@/lib/broadcast-runner"
  ));

  orgId = (await prisma.organization.create({ data: { name: `TP Org ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `TP ws ${S}`, organizationId: orgId } })
  ).id;
  templateId = (
    await prisma.messageTemplate.create({
      data: {
        workspaceId,
        // Templates are WABA-scoped in Meta, so the FK is required — a template
        // belonging to "no WABA" is what the retired `""` sentinel represented.
        wabaAccountId: await seedWabaAccount(prisma, workspaceId, `ph_waba_${S}`),
        name: `promo_${S}`,
        language: "en_US",
        category: "marketing",
        status: "approved",
        bodyText: "Hi {{1}}",
        components: [{ type: "BODY", text: "Hi {{1}}" }],
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.broadcastRecipient.deleteMany({ where: { broadcast: { workspaceId } } });
  await prisma.broadcast.deleteMany({ where: { workspaceId } });
  await prisma.contact.deleteMany({ where: { workspaceId } });
  await prisma.messageTemplate.deleteMany({ where: { workspaceId } });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeBroadcast(
  status: "running" | "queued" | "scheduled" | "completed",
  overrides: Record<string, unknown> = {},
) {
  const b = await prisma.broadcast.create({
    data: {
      workspaceId,
      name: `${status} ${S}`,
      channel: "whatsapp",
      kind: "template",
      templateId,
      templateName: `promo_${S}`,
      templateLanguage: "en_US",
      status,
      totalCount: 1,
      variables: { body: [] },
      audienceMode: "all",
      ...overrides,
    },
  });
  // A resume needs something left to send, or the row is marked completed
  // instead — so each campaign gets one still-queued recipient.
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `TP contact ${b.id.slice(-6)}`,
      identityChannel: "whatsapp",
      phoneNumber: `1555${b.id.slice(-7)}`,
    },
  });
  await prisma.broadcastRecipient.create({
    data: { broadcastId: b.id, contactId: contact.id, status: "queued" },
  });
  return b.id;
}

const read = (id: string) =>
  prisma.broadcast.findUniqueOrThrow({
    where: { id },
    select: { status: true, pausedReason: true, lastError: true },
  });

describe("pausing a template halts its campaigns", () => {
  it("parks running, queued AND scheduled campaigns", async () => {
    const running = await makeBroadcast("running");
    const queued = await makeBroadcast("queued");
    const scheduled = await makeBroadcast("scheduled");

    const n = await pauseBroadcastsForTemplate(
      workspaceId,
      templateId,
      "Template is paused at Meta.",
    );
    expect(n).toBe(3);

    for (const id of [running, queued, scheduled]) {
      const row = await read(id);
      expect(row.status).toBe("paused");
      // `template` is the reason the periodic auto-resume sweep skips — these
      // wait for the approval webhook or an operator, not a cooldown.
      expect(row.pausedReason).toBe("template");
      expect(row.lastError).toBe("Template is paused at Meta.");
    }
  });

  it("leaves terminal campaigns alone", async () => {
    const done = await makeBroadcast("completed");
    await pauseBroadcastsForTemplate(workspaceId, templateId, "x");
    expect((await read(done)).status).toBe("completed");
  });

  it("never touches another workspace's campaigns", async () => {
    // The tenancy boundary is load-bearing here: this runs off a webhook, and a
    // template id is not proof of workspace.
    const otherOrg = await prisma.organization.create({
      data: { name: `TP Other ${S}`, status: "active" },
    });
    const otherWs = await prisma.workspace.create({
      data: { name: `TP other ws ${S}`, organizationId: otherOrg.id },
    });
    const foreign = await prisma.broadcast.create({
      data: {
        workspaceId: otherWs.id,
        name: `foreign ${S}`,
        channel: "whatsapp",
        kind: "template",
        templateId,
        status: "running",
        totalCount: 1,
        variables: { body: [] },
        audienceMode: "all",
      },
    });

    await pauseBroadcastsForTemplate(workspaceId, templateId, "x");

    const row = await prisma.broadcast.findUniqueOrThrow({
      where: { id: foreign.id },
      select: { status: true },
    });
    expect(row.status).toBe("running");

    await prisma.broadcast.deleteMany({ where: { workspaceId: otherWs.id } });
    await prisma.workspace.deleteMany({ where: { id: otherWs.id } });
    await prisma.organization.deleteMany({ where: { id: otherOrg.id } });
  });
});

describe("re-approving the template releases them", () => {
  // Its own set: the halt tests above leave rows parked on this template, and
  // this block asserts an exact count.
  beforeAll(async () => {
    await prisma.broadcastRecipient.deleteMany({ where: { broadcast: { workspaceId } } });
    await prisma.broadcast.deleteMany({ where: { workspaceId } });
  });

  it("resumes only what WE parked for this template", async () => {
    const ours = await makeBroadcast("paused" as "queued", {
      status: "paused",
      pausedReason: "template",
    });
    // Paused for a different cause, and paused by a human — neither is this
    // function's business.
    const credentials = await makeBroadcast("paused" as "queued", {
      status: "paused",
      pausedReason: "credentials",
    });
    const byHand = await makeBroadcast("paused" as "queued", {
      status: "paused",
      pausedReason: null,
    });

    const n = await resumeBroadcastsForTemplate(workspaceId, templateId);
    expect(n).toBe(1);

    // Assert on `pausedReason`, NOT on `status`.
    //
    // Resuming doesn't just flip a column — it re-fires the campaign, and with
    // the worker inline the runner can legitimately re-park it before this line
    // executes (this workspace has no WhatsApp credentials, so the runner parks
    // it `not_connected` and logs "not connected at fire time"). Asserting
    // `status === "queued"` was therefore a race against a background write the
    // product is SUPPOSED to make: green alone in the file, red roughly 1 run in
    // 2 in the full suite, where a sibling spec has already warmed the queue.
    //
    // Exactly two end states are legitimate, and both prove the resume ran:
    //   - the runner hasn't picked it up yet  → status "queued"
    //   - the runner picked it up and re-parked → pausedReason "not_connected"
    // Anything else (still "paused" for reason "template") means it was never
    // resumed, which is the real regression this guards.
    //
    // Note `pausedReason` is NOT cleared on resume, so a still-queued row keeps
    // the stale "template" reason — which is why the check is a disjunction on
    // these two fields rather than a single assertion on either one.
    const resumed = await read(ours);
    expect(
      resumed.status === "queued" || resumed.pausedReason === "not_connected",
      `expected resumed-or-refired, got status=${resumed.status} reason=${resumed.pausedReason}`,
    ).toBe(true);

    // The other two must be untouched — same status AND same reason. Checking
    // the reason too is what proves they were skipped rather than resumed and
    // coincidentally re-parked.
    const cred = await read(credentials);
    expect(cred.status).toBe("paused");
    expect(cred.pausedReason).toBe("credentials");
    const hand = await read(byHand);
    expect(hand.status).toBe("paused");
    expect(hand.pausedReason).toBeNull();
  });

  it("is a no-op when nothing was parked", async () => {
    expect(await resumeBroadcastsForTemplate(workspaceId, templateId)).toBe(0);
  });
});
