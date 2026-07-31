/**
 * Instagram, driven END TO END against the real database.
 *
 * Every other Instagram spec asserts an INTERMEDIATE: the parser's output, a
 * provider's request body, a pure rule. This one asserts the DELIVERED state —
 * what actually lands in Postgres after a real Meta webhook body goes through the
 * real parser, the real per-account grouping, the real non-DM gate and the real
 * ingest, and what actually goes on the wire when an agent then replies.
 *
 * That distinction has bitten this codebase before: a field can be on the type,
 * set by the publisher and shown in the docs, and still be absent from the row
 * that commits. Four things here can only be observed this way:
 *
 *  1. A comment must NOT bump `Contact.lastInboundAt`. That column is the window
 *     clock the composer and every send guard read. The flag that suppresses it
 *     is threaded parser → event → ingest → a conditional `updateMany`, and
 *     nothing short of reading the committed row proves it survived the trip.
 *  2. A DM must STILL bump it — the same conditional, in the other direction. A
 *     regression there closes the window on every real conversation.
 *  3. Comment and DM must land on ONE contact and ONE conversation, because the
 *     comment webhook's `from.id` is the same IGSID space as a DM sender. If it
 *     were not, every commenter would fork into a duplicate contact.
 *  4. The reply an agent types on a comment-only thread must leave as a private
 *     reply addressed at the COMMENT — and the second one must be refused
 *     locally rather than by a billed Meta rejection.
 *
 *   pnpm --filter @ccp/api exec vitest run test/instagram-end-to-end.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";

// The bus is irrelevant to what commits; stub publish so the outbox drainer and
// socket fanout don't reach for infrastructure this spec doesn't run.
vi.mock("@/lib/events/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/bus")>();
  return { ...actual, publish: vi.fn(async () => undefined) };
});
// The ONLY thing standing in for Meta. Everything below it is production code.
vi.mock("@/lib/providers/meta-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/meta-graph")>();
  return { ...actual, graphPostJson: vi.fn() };
});

import { graphPostJson } from "@/lib/providers/meta-graph";
import { instagramProvider } from "@/lib/providers/instagram";
import { groupEventsByInboundAccount } from "@/lib/providers/inbound-accounts";
import { getInstagramInboxSources, invalidateInstagramConfig } from "@/lib/providers/instagram-config";
import {
  INBOX_SOURCES,
  inboxSourceOfStructuredKind,
} from "@ccp/shared/providers/capabilities";
import { encryptSecret } from "@/lib/crypto/envelope";
import { sendTextInternal } from "@/lib/messaging/send-text-internal";
import { sendInteractiveInternal } from "@/lib/messaging/send-interactive-internal";
import { ingestWithRedelivery } from "./_ingest-redelivery";
import type { NormalizedEvent } from "@ccp/shared/providers/types";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `ige${Date.now().toString().slice(-8)}`;
const IG_ID = `${S}_ig`;
const PAGE_ID = `${S}_page`;
const IGSID = `${S}_igsid`;

let orgId = "";
let workspaceId = "";
let connId = "";
let seq = 0;

const postJson = vi.mocked(graphPostJson);

/** A real `object:"instagram"` DM body, in Meta's documented shape. */
function dmBody(mid: string, text: string) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: IGSID },
            recipient: { id: IG_ID },
            timestamp: Date.now(),
            message: { mid, text },
          },
        ],
      },
    ],
  };
}

/** A real `comments` change body, in Meta's documented shape. */
function commentBody(commentId: string, text: string) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: Date.now(),
        changes: [
          {
            field: "comments",
            value: {
              from: { id: IGSID, username: "a_customer" },
              comment_id: commentId,
              text,
              media: { id: `${S}_media`, media_product_type: "FEED" },
            },
          },
        ],
      },
    ],
  };
}

/**
 * The controller's real pipeline: parse → group by account → apply the non-DM
 * gate → ingest per group. Mirrored here rather than calling the Nest controller
 * so the spec needs no HTTP server, but every step below the HTTP layer is the
 * production function.
 */
async function deliver(payload: unknown): Promise<number> {
  const events = instagramProvider.parseWebhook(payload);
  const { groups } = await groupEventsByInboundAccount(workspaceId, "instagram", events);
  let ingested = 0;
  for (const group of groups) {
    const allowed = await getInstagramInboxSources(workspaceId, group.channelConnectionId);
    const permitted = group.events.filter((e: NormalizedEvent) => {
      const source =
        e.kind === "message" ? inboxSourceOfStructuredKind(e.structured?.kind) : null;
      return source === null || allowed.has(source);
    });
    if (permitted.length === 0) continue;
    await ingestWithRedelivery(workspaceId, "instagram", permitted, group.channelConnectionId);
    ingested += permitted.length;
  }
  return ingested;
}

async function setInboxSources(sources: string[]) {
  const row = await prisma.channelConnection.findUniqueOrThrow({
    where: { id: connId },
    select: { config: true },
  });
  await prisma.channelConnection.update({
    where: { id: connId },
    data: {
      config: { ...(row.config as object), inboxSources: sources } as never,
    },
  });
  invalidateInstagramConfig(workspaceId);
}

async function theContact() {
  return prisma.contact.findFirstOrThrow({
    where: { workspaceId, identityChannel: "instagram", externalContactId: IGSID },
    select: { id: true, lastInboundAt: true, name: true },
  });
}

async function theThread() {
  const contact = await theContact();
  return prisma.conversation.findFirstOrThrow({
    where: { workspaceId, contactId: contact.id },
    select: { id: true, channelConnectionId: true },
  });
}

beforeEach(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  seq += 1;
  postJson.mockReset();
  postJson.mockImplementation(async () => ({ message_id: `mid.OUT.${seq}` }));

  orgId = (await prisma.organization.create({ data: { name: `IGE Org ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `IGE WS ${S}`, organizationId: orgId } })
  ).id;
  connId = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "instagram",
        // The IG professional-account id — what Meta puts in `entry[].id`.
        externalAccountId: IG_ID,
        isDefault: true,
        isActive: true,
        config: { igId: IG_ID, pageId: PAGE_ID },
        secrets: {
          igAccessToken: encryptSecret("PAGE_TOKEN"),
          appSecret: encryptSecret("APP_SECRET"),
        },
      },
      select: { id: true },
    })
  ).id;
  invalidateInstagramConfig(workspaceId);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("a direct message — the core, never gated", () => {
  it("lands as a contact + conversation + message and OPENS the window", async () => {
    expect(await deliver(dmBody(`${S}.dm1`, "hello there"))).toBe(1);

    const contact = await theContact();
    const thread = await theThread();
    const msg = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `${S}.dm1` },
      select: { body: true, direction: true, conversationId: true, channelConnectionId: true },
    });

    expect(msg.body).toBe("hello there");
    expect(msg.direction).toBe("in");
    expect(msg.conversationId).toBe(thread.id);
    // Per-event account attribution really reached the row.
    expect(msg.channelConnectionId).toBe(connId);
    expect(thread.channelConnectionId).toBe(connId);
    // The window clock MUST advance for a DM — the other half of the conditional
    // that suppresses it for comments.
    expect(contact.lastInboundAt).not.toBeNull();
  });

  it("is delivered even with every non-DM source switched off", async () => {
    await setInboxSources([]);
    expect(await deliver(dmBody(`${S}.dm2`, "still core"))).toBe(1);
    expect(
      await prisma.message.count({ where: { workspaceId, externalId: `${S}.dm2` } }),
    ).toBe(1);
  });
});

describe("a comment — gated, and it must not fake a messaging window", () => {
  it("is DROPPED by default: an admin has not asked for it", async () => {
    expect(await deliver(commentBody(`${S}.c1`, "do you ship?"))).toBe(0);

    expect(await prisma.message.count({ where: { workspaceId } })).toBe(0);
    // Nothing at all — no contact conjured for a source nobody enabled.
    expect(
      await prisma.contact.count({ where: { workspaceId, externalContactId: IGSID } }),
    ).toBe(0);
  });

  it("is delivered once the admin enables it, and does NOT open the window", async () => {
    await setInboxSources(["comments"]);
    expect(await deliver(commentBody(`${S}.c2`, "do you ship?"))).toBe(1);

    const msg = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `comment:${S}.c2` },
      select: { body: true, structured: true },
    });
    expect(msg.body).toBe("do you ship?");
    expect(msg.structured).toMatchObject({
      kind: "comment",
      commentId: `${S}.c2`,
      username: "a_customer",
    });

    // THE assertion this whole file exists for. A comment grants one private
    // reply, not a 24-hour conversation — if this ever reads non-null, the
    // composer and every send guard start believing the thread is open and hand
    // Meta sends it is certain to reject.
    expect((await theContact()).lastInboundAt).toBeNull();
  });

  it("shares ONE contact and ONE thread with that person's DMs", async () => {
    await setInboxSources(["comments"]);
    await deliver(commentBody(`${S}.c3`, "do you ship?"));
    await deliver(dmBody(`${S}.dm3`, "hi again"));

    // The comment webhook's `from.id` is the same IGSID space as a DM sender —
    // the fact the whole design rests on. A second contact here would mean every
    // commenter forks into a duplicate.
    expect(
      await prisma.contact.count({ where: { workspaceId, externalContactId: IGSID } }),
    ).toBe(1);
    expect(await prisma.conversation.count({ where: { workspaceId } })).toBe(1);
    expect(await prisma.message.count({ where: { workspaceId } })).toBe(2);
    // …and the DM DID open the window even though the comment before it didn't.
    expect((await theContact()).lastInboundAt).not.toBeNull();
  });

  it("is idempotent across Meta's at-least-once redelivery", async () => {
    await setInboxSources(["comments"]);
    const body = commentBody(`${S}.c4`, "twice");
    await deliver(body);
    await deliver(body);

    expect(await prisma.message.count({ where: { workspaceId } })).toBe(1);
  });
});

describe("templates go out through the REAL send path, not just the provider", () => {
  it("commits a generic-template send and puts Meta's element shape on the wire", async () => {
    // Templates were verified at the provider (wire shape) and at the schema
    // (caps) — but never THROUGH `sendInteractiveInternal` to a committed row.
    // That is the layer where the capability gate, the window check and the
    // message write live, and a template that passes both other layers can still
    // be refused or mis-stored here.
    await deliver(dmBody(`${S}.dmT`, "got any hats?"));
    const thread = await theThread();

    const res = await sendInteractiveInternal({
      workspaceId,
      conversationId: thread.id,
      bodyText: "Our hats",
      kind: "generic",
      options: [],
      genericCards: [
        {
          title: "Wool cap",
          subtitle: "Warm and grey",
          imageUrl: "https://example.com/cap.jpg",
          buttons: [{ type: "web_url", title: "Buy", url: "https://example.com/cap" }],
        },
      ],
      sentVia: "api",
    });

    // The DELIVERED wire — Meta's documented element shape, not our input shape.
    const body = postJson.mock.calls[0]![2] as Record<string, unknown>;
    expect(body.message).toEqual({
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: "Wool cap",
              subtitle: "Warm and grey",
              image_url: "https://example.com/cap.jpg",
              buttons: [
                { type: "web_url", url: "https://example.com/cap", title: "Buy" },
              ],
            },
          ],
        },
      },
    });
    // …and the row that actually committed.
    const row = await prisma.message.findFirstOrThrow({
      where: { workspaceId, id: res.messageId },
      select: { direction: true, channel: true, rawPayload: true, channelConnectionId: true },
    });
    expect(row.direction).toBe("out");
    expect(row.channel).toBe("instagram");
    expect(row.channelConnectionId).toBe(connId);
    // The structured intent is preserved on the row, so the bubble and any audit
    // reader can tell a card send from a plain reply.
    expect((row.rawPayload as { interactive?: { kind?: string } }).interactive?.kind).toBe(
      "generic",
    );
  });

  it("commits a product template as bare catalog ids", async () => {
    await deliver(dmBody(`${S}.dmP`, "show me products"));
    const thread = await theThread();

    await sendInteractiveInternal({
      workspaceId,
      conversationId: thread.id,
      bodyText: "Have a look",
      kind: "product",
      options: [],
      productIds: ["PROD-1", "PROD-2"],
      sentVia: "api",
    });

    const body = postJson.mock.calls[0]![2] as Record<string, unknown>;
    expect(body.message).toEqual({
      attachment: {
        type: "template",
        payload: {
          template_type: "product",
          elements: [{ id: "PROD-1" }, { id: "PROD-2" }],
        },
      },
    });
  });

  it("REFUSES a template when the messaging window is shut", async () => {
    // A template is not a window escape on Instagram — there is no approved
    // template catalogue here, so an out-of-window card is simply a send Meta
    // will reject. The gate must be the same one plain text gets.
    await setInboxSources(["comments"]);
    await deliver(commentBody(`${S}.cT`, "any hats?"));
    const thread = await theThread();

    await expect(
      sendInteractiveInternal({
        workspaceId,
        conversationId: thread.id,
        bodyText: "Our hats",
        kind: "generic",
        options: [],
        genericCards: [{ title: "Wool cap", subtitle: "Warm" }],
        sentVia: "api",
      }),
    ).rejects.toMatchObject({ code: "outside_24h_window" });
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("the default-off invariant, for EVERY non-DM source", () => {
  it("a freshly connected account admits nothing but direct messages", async () => {
    // Written against the LIST, not against `comments`, so a source added later
    // cannot arrive switched on. `inboxSources` is absent on a new connection,
    // and absent must mean none — not "unset, so allow".
    const allowed = await getInstagramInboxSources(workspaceId, connId);
    for (const source of INBOX_SOURCES) {
      expect(allowed.has(source), `${source} must be OFF on a new account`).toBe(false);
    }
    expect(allowed.size).toBe(0);
  });

  it("an unknown source stored by hand or an older build is ignored, not honoured", async () => {
    // Stored JSON is not a contract. A value outside the canonical list must not
    // become a source that silently matches nothing downstream — or worse, one
    // that a future rename accidentally re-activates.
    await setInboxSources(["comments", "totally_made_up"]);
    const allowed = await getInstagramInboxSources(workspaceId, connId);
    expect([...allowed]).toEqual(["comments"]);
  });

  it("is per ACCOUNT — enabling one handle does not enable a sibling", async () => {
    await setInboxSources(["comments"]);
    const sibling = await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "instagram",
        externalAccountId: `${IG_ID}_sib`,
        isDefault: false,
        isActive: true,
        config: { igId: `${IG_ID}_sib`, pageId: `${PAGE_ID}_sib` },
        secrets: { igAccessToken: encryptSecret("T"), appSecret: encryptSecret("S") },
      },
      select: { id: true },
    });
    invalidateInstagramConfig(workspaceId);

    // A workspace can reasonably want comments on its support handle and not on
    // its brand handle. Resolving this per workspace — or from the default
    // account — would file one handle's comments against the other's wishes.
    expect((await getInstagramInboxSources(workspaceId, sibling.id)).size).toBe(0);
    expect((await getInstagramInboxSources(workspaceId, connId)).has("comments")).toBe(true);
  });

  it("refuses to guess when the account is unknown", async () => {
    // No account = no answer, and the answer is NONE. Falling back to the
    // workspace default here is the same class of mistake as resolving inbound
    // HMAC from the default account.
    expect((await getInstagramInboxSources(workspaceId, null)).size).toBe(0);
    expect((await getInstagramInboxSources(workspaceId, undefined)).size).toBe(0);
  });
});

describe("replying to a comment — the delivered wire, not the intent", () => {
  it("goes out as a PRIVATE REPLY addressed at the comment", async () => {
    await setInboxSources(["comments"]);
    await deliver(commentBody(`${S}.c5`, "do you ship?"));
    const thread = await theThread();

    // The real send path: window gate, private-reply resolution, provider, and
    // the row it writes. Nothing here is mocked except Graph itself.
    await sendTextInternal({
      workspaceId,
      conversationId: thread.id,
      body: "Yes — where to?",
      sentVia: "api",
    });

    const body = postJson.mock.calls[0]![2] as Record<string, unknown>;
    // Addressed at the COMMENT, with no window fields — there is no window yet,
    // which is the entire reason this send shape exists.
    expect(body).toEqual({
      recipient: { comment_id: `${S}.c5` },
      message: { text: "Yes — where to?" },
    });

    // And the outbound row is LINKED to the comment it answers — which is what
    // makes "this comment's one reply is spent" answerable without asking Meta.
    const comment = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `comment:${S}.c5` },
      select: { id: true },
    });
    const reply = await prisma.message.findFirstOrThrow({
      where: { workspaceId, direction: "out" },
      select: { replyToMessageId: true },
    });
    expect(reply.replyToMessageId).toBe(comment.id);
  });

  it("refuses a SECOND reply locally instead of buying a Meta rejection", async () => {
    await setInboxSources(["comments"]);
    await deliver(commentBody(`${S}.c6`, "do you ship?"));
    const thread = await theThread();

    await sendTextInternal({
      workspaceId,
      conversationId: thread.id,
      body: "first",
      sentVia: "api",
    });
    postJson.mockClear();

    // Meta permits exactly one private reply per comment. The second must fail
    // here, before a billed round trip.
    await expect(
      sendTextInternal({
        workspaceId,
        conversationId: thread.id,
        body: "second",
        sentVia: "api",
      }),
    ).rejects.toMatchObject({ code: "outside_24h_window" });
    expect(postJson).not.toHaveBeenCalled();
  });

  it("uses an ORDINARY DM once the person has written — not the comment", async () => {
    await setInboxSources(["comments"]);
    await deliver(commentBody(`${S}.c7`, "do you ship?"));
    await deliver(dmBody(`${S}.dm7`, "hi, yes please"));
    const thread = await theThread();

    await sendTextInternal({
      workspaceId,
      conversationId: thread.id,
      body: "Great — where to?",
      sentVia: "api",
    });

    const body = postJson.mock.calls[0]![2] as Record<string, unknown>;
    // A real conversation is open, so the ordinary shape is both legal and
    // better — burning the single per-comment reply on it would be strictly
    // worse, and unrecoverable.
    expect(body).toMatchObject({
      recipient: { id: IGSID },
      messaging_type: "RESPONSE",
      message: { text: "Great — where to?" },
    });
    expect(body.recipient).not.toHaveProperty("comment_id");
  });
});
