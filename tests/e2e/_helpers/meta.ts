/**
 * Harness for the Meta-channels e2e suite (WhatsApp / Messenger / Instagram).
 *
 * WHY A DEDICATED TEST TEAM. This box's dev DB holds the maintainer's REAL,
 * live-tested channel connections, and `@@unique([workspaceId, channel])` means we
 * can't seed test connections next to them without clobbering the real ones. So
 * every backend meta spec runs under a throwaway team (`META_TEST_TEAM_ID`) with
 * its own MetaConnection + per-channel connections (known test secrets) + an API
 * key, and tears the whole team down afterwards. The maintainer's team is never
 * touched.
 *
 * WHY A SEPARATE API PORT. Outbound sends go through the `message-sends` BullMQ
 * queue + worker, and the real send code posts to graph.facebook.com. So the
 * suite runs a SECOND api process (`META_API_BASE`, default :4001) launched with
 * `META_GRAPH_BASE_URL` → the mock Graph server and an ISOLATED Redis DB (so its
 * worker never steals the maintainer stack's jobs, and vice-versa). Backend
 * specs drive that api directly; API keys + webhook HMAC are session-independent,
 * so no browser login is needed. See tests/e2e/_mock/run-meta-stack.sh.
 */

import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";

import { encryptSecret } from "../../../apps/api/src/lib/crypto/envelope-core";
import { generateApiKey } from "../../../apps/api/src/auth/api-key";
import { db } from "./db";

// The mock-backed test api + mock Graph control plane.
export const META_API_BASE = process.env.META_API_BASE ?? "http://127.0.0.1:4001";
export const GRAPH_MOCK_BASE = process.env.GRAPH_MOCK_BASE ?? "http://127.0.0.1:4100";

// Stable ids so a crashed run's leftovers are overwritten, not duplicated.
export const META_TEST_TEAM_ID = "e2e-meta-team";
const META_TEST_USER_ID = "e2e-meta-user";

// Known plaintext secrets — the whole point is that the spec can sign webhooks
// with the SAME app secret the ingest path will verify against.
export const APP_SECRET = "e2e_meta_app_secret_0123456789abcdef";
export const VERIFY_TOKEN = "e2e_meta_verify_token_fedcba9876543210";
const SYSTEM_USER_TOKEN = "e2e_meta_system_user_token";

// Per-channel identity + token fixtures. Account 1 is the DEFAULT on each
// channel; account 2 exists so every spec can assert the thing the product
// promises — that two accounts are cleanly seen as two.
export const WA_PHONE_NUMBER_ID = "e2e_wa_phone_1";
export const WA_WABA_ID = "e2e_wa_waba_1";
export const WA_ACCESS_TOKEN = "e2e_wa_access_token";
export const MSGR_PAGE_ID = "e2e_msgr_page_1";
export const MSGR_PAGE_TOKEN = "e2e_msgr_page_token";
export const IG_ID = "e2e_ig_1";
export const IG_PAGE_ID = "e2e_ig_page_1";
export const IG_ACCESS_TOKEN = "e2e_ig_access_token";

/**
 * Deterministic ChannelConnection row ids, so a spec can bind a conversation or
 * a broadcast to a specific account without a lookup — and so a mid-suite
 * wipe + re-seed reproduces them byte-identically (see the `id:` comment in the
 * seed below for why that is load-bearing).
 */
export const CONN_ID = {
  whatsapp: `${META_TEST_TEAM_ID}_conn_whatsapp`,
  messenger: `${META_TEST_TEAM_ID}_conn_messenger`,
  instagram: `${META_TEST_TEAM_ID}_conn_instagram`,
} as const;

export interface MetaTestTeam {
  workspaceId: string;
  userId: string;
  apiToken: string;
}

/**
 * Idempotently (re)create the throwaway team with a Meta App connection + the
 * three channel connections + an unrestricted API key. Returns the API-key
 * plaintext for `Authorization: Bearer` against META_API_BASE.
 */
export async function seedMetaTestTeam(): Promise<MetaTestTeam> {
  const d = db();

  // META_TEST_TEAM_ID is now the WORKSPACE id (the isolation scope every
  // `workspaceId` column points at); it hangs off a throwaway Organization,
  // which is where the approval gate lives.
  const orgId = `${META_TEST_TEAM_ID}_org`;
  await d.organization.upsert({
    where: { id: orgId },
    create: { id: orgId, name: "E2E Meta Test Org", status: "active" },
    update: { status: "active" },
  });

  await d.workspace.upsert({
    where: { id: META_TEST_TEAM_ID },
    create: {
      id: META_TEST_TEAM_ID,
      name: "E2E Meta Test Team",
      organizationId: orgId,
    },
    // Tickets are raised deliberately (auto-open was removed 2026-07-25);
    // ingest only ATTACHES an inbound to the thread's active ticket or reopens
    // a recently-solved one — ticket-routing.spec.ts seeds its tickets via /v1.
    update: { organizationId: orgId },
  });

  await d.user.upsert({
    where: { id: META_TEST_USER_ID },
    create: {
      id: META_TEST_USER_ID,
      organizationId: orgId,
      orgRole: "admin",
      name: "E2E Meta User",
      email: "e2e-meta-user@loadless.test",
      // Fixtures are created directly in the database, which is the same
      // proof-of-control the invite flow relies on. `emailVerified` defaults to
      // FALSE and `resolveSession` refuses an unverified user, so without this
      // every API call from this fixture 403s `email_not_verified`.
      emailVerified: true,
    },
    update: { organizationId: orgId },
  });

  // The admin role is a per-workspace grant now.
  await d.workspaceMember.upsert({
    where: {
      userId_workspaceId: { userId: META_TEST_USER_ID, workspaceId: META_TEST_TEAM_ID },
    },
    create: { userId: META_TEST_USER_ID, workspaceId: META_TEST_TEAM_ID, role: "admin" },
    update: { role: "admin" },
  });

  // Shared Meta App connection — the single source the webhook loaders prefer
  // for the HMAC secret and the verify token.
  await d.metaConnection.upsert({
    where: { workspaceId: META_TEST_TEAM_ID },
    create: {
      workspaceId: META_TEST_TEAM_ID,
      config: { appId: "e2e_app_id", verifyToken: VERIFY_TOKEN },
      secrets: {
        appSecret: encryptSecret(APP_SECRET),
        systemUserToken: encryptSecret(SYSTEM_USER_TOKEN),
      },
    },
    update: {
      config: { appId: "e2e_app_id", verifyToken: VERIFY_TOKEN },
      secrets: {
        appSecret: encryptSecret(APP_SECRET),
        systemUserToken: encryptSecret(SYSTEM_USER_TOKEN),
      },
    },
  });

  // Per-channel connections. `secrets.appSecret` + `config.verifyToken` are what
  // the webhook loader's gate requires before it prefers the shared secret.
  const channels: Array<{
    channel: "whatsapp" | "messenger" | "instagram";
    /** The provider's own account id — the key a workspace's accounts differ by. */
    accountId: string;
    /** Deterministic row id, so specs can bind to an account without a lookup. */
    connId: string;
    /** Exactly one per channel. The rest exist to prove they stay separate. */
    isDefault: boolean;
    /** WhatsApp only — the template-catalog scope. */
    wabaId?: string;
    label: string;
    config: Prisma.InputJsonObject;
    secrets: Prisma.InputJsonObject;
  }> = [
    {
      channel: "whatsapp",
      accountId: WA_PHONE_NUMBER_ID,
      connId: CONN_ID.whatsapp,
      isDefault: true,
      wabaId: WA_WABA_ID,
      label: "Sales line",
      config: { phoneNumberId: WA_PHONE_NUMBER_ID, wabaId: WA_WABA_ID, verifyToken: VERIFY_TOKEN },
      secrets: { accessToken: encryptSecret(WA_ACCESS_TOKEN), appSecret: encryptSecret(APP_SECRET) },
    },
    {
      channel: "messenger",
      accountId: MSGR_PAGE_ID,
      connId: CONN_ID.messenger,
      isDefault: true,
      label: "Main Page",
      config: { pageId: MSGR_PAGE_ID, pageName: "Mock Page", verifyToken: VERIFY_TOKEN },
      secrets: { pageAccessToken: encryptSecret(MSGR_PAGE_TOKEN), appSecret: encryptSecret(APP_SECRET) },
    },
    {
      channel: "instagram",
      accountId: IG_ID,
      connId: CONN_ID.instagram,
      isDefault: true,
      label: "Main IG",
      config: { igId: IG_ID, pageId: IG_PAGE_ID, igUsername: "mock_ig", verifyToken: VERIFY_TOKEN },
      secrets: { igAccessToken: encryptSecret(IG_ACCESS_TOKEN), appSecret: encryptSecret(APP_SECRET) },
    },
  ];
  for (const c of channels) {
    // Drop any OTHER default on this channel before claiming it. The partial
    // unique `ChannelConnection_one_default_per_channel` permits exactly one
    // default per (workspace, channel), so a second account left as default by
    // an earlier spec turns this seed into a P2002 — and a seed that throws
    // fails every test downstream of it with an error about channel accounts.
    await d.$transaction(async (tx) => {
      // Only the default-claiming account demotes siblings. A NON-default
      // account must never touch the default flag, or seeding account 2 would
      // silently leave the channel with no default at all.
      if (c.isDefault) {
        await tx.channelConnection.updateMany({
          where: {
            workspaceId: META_TEST_TEAM_ID,
            channel: c.channel,
            isDefault: true,
            NOT: { externalAccountId: c.accountId },
          },
          data: { isDefault: false },
        });
      }
      // The WABA is a first-class row (Meta: portfolio → WABA → number), and
      // `externalWabaId` is GLOBALLY unique, so upsert rather than create.
      const wabaAccountId = c.wabaId
        ? (
            await tx.whatsappBusinessAccount.upsert({
              where: { externalWabaId: c.wabaId },
              create: { workspaceId: META_TEST_TEAM_ID, externalWabaId: c.wabaId },
              update: {},
              select: { id: true },
            })
          ).id
        : null;
      await tx.channelConnection.upsert({
        where: {
          workspaceId_channel_externalAccountId: {
            workspaceId: META_TEST_TEAM_ID,
            channel: c.channel,
            externalAccountId: c.accountId,
          },
        },
        create: {
          // DETERMINISTIC id — load-bearing for the whole suite. The api
          // process caches provider config (connection id included) for 60s;
          // a mid-suite wipeMetaTestTeam() + re-seed used to mint a FRESH
          // cuid, so any file running inside that window had ingest resolve
          // the cached, now-deleted connection id → FK failure → fail-soft
          // 200 with no row ("posted 200, row never appeared" — the classic
          // meta-suite flake). With a fixed id, wipe + re-seed reproduces the
          // row byte-identically and a stale cache is indistinguishable from
          // a fresh one.
          id: c.connId,
          workspaceId: META_TEST_TEAM_ID,
          channel: c.channel,
          externalAccountId: c.accountId,
          isDefault: c.isDefault,
          label: c.label,
          ...(wabaAccountId ? { wabaAccountId } : {}),
          config: c.config,
          secrets: c.secrets,
          isActive: true,
        },
        update: {
          isDefault: c.isDefault,
          label: c.label,
          ...(wabaAccountId ? { wabaAccountId } : {}),
          config: c.config,
          secrets: c.secrets,
          isActive: true,
        },
      });
    });
  }

  // PRUNE accounts this fixture no longer declares.
  //
  // The upserts above converge the rows they name but say nothing about rows
  // they don't, so the fixture could never shrink: an experiment that added a
  // second account per channel left those rows behind after the code was
  // reverted, and the shared team silently stayed MULTI-account. Every spec
  // that creates a conversation without binding one then failed
  // `account-unresolved` — a correct refusal, blamed on the wrong change.
  //
  // This fixture is deliberately SINGLE-account (it is the control that proves
  // the one-account experience never regressed); the multi-account workspace
  // lives in `_helpers/multi-account.ts`.
  await d.channelConnection.deleteMany({
    where: {
      workspaceId: META_TEST_TEAM_ID,
      NOT: { externalAccountId: { in: channels.map((c) => c.accountId) } },
    },
  });

  // Deterministic DEFAULT STAGE — same reasoning as the fixed connection ids
  // above, and the actual root of the historical "posted 200, row never
  // appeared" flake: the api caches (workspaceId → default stage id) inside
  // ensureDefaultStage, so a wipe + re-seed that let the api mint a FRESH
  // stage id left every contact.create in the next file failing
  // `Contact_stageId_fkey` against the cached, deleted id — swallowed as
  // per-event poison with a 200 (see tests/e2e/.meta-logs/test-api.log for
  // the `ingest.event_failed` trail that finally exposed it, 2026-07-28).
  // Demote any stray default first so the one-default-per-team partial
  // unique can't reject the upsert on a dirty database.
  await d.contactStage.updateMany({
    where: {
      workspaceId: META_TEST_TEAM_ID,
      isDefault: true,
      NOT: { id: `${META_TEST_TEAM_ID}_stage_default` },
    },
    data: { isDefault: false },
  });
  await d.contactStage.upsert({
    where: { id: `${META_TEST_TEAM_ID}_stage_default` },
    create: {
      id: `${META_TEST_TEAM_ID}_stage_default`,
      workspaceId: META_TEST_TEAM_ID,
      name: "New",
      position: 0,
      isDefault: true,
    },
    update: { isDefault: true },
  });

  // Unrestricted API key so /v1 sends run without a browser session.
  const key = generateApiKey();
  await d.workspaceApiKey.deleteMany({ where: { workspaceId: META_TEST_TEAM_ID } });
  await d.workspaceApiKey.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      name: "e2e-meta",
      tokenHash: key.tokenHash,
      tokenPrefix: key.tokenPrefix,
      createdById: META_TEST_USER_ID,
      scopes: ["*"],
    },
  });

  return { workspaceId: META_TEST_TEAM_ID, userId: META_TEST_USER_ID, apiToken: key.token };
}

/** Full teardown — the whole team and everything under it. */
export async function wipeMetaTestTeam(): Promise<void> {
  const d = db();
  const workspaceId = META_TEST_TEAM_ID;
  // Child → parent. Wrapped in a single tx so a mid-delete failure rolls back.
  await d.$transaction([
    d.outboundSendAttempt.deleteMany({ where: { workspaceId } }),
    d.apiIdempotencyKey.deleteMany({ where: { workspaceId } }),
    d.conversationEvent.deleteMany({ where: { workspaceId } }),
    d.internalNote.deleteMany({ where: { workspaceId } }),
    d.message.deleteMany({ where: { workspaceId } }),
    d.conversation.deleteMany({ where: { workspaceId } }),
    d.contact.deleteMany({ where: { workspaceId } }),
    d.workspaceApiKey.deleteMany({ where: { workspaceId } }),
    d.channelConnection.deleteMany({ where: { workspaceId } }),
    d.metaConnection.deleteMany({ where: { workspaceId } }),
    // Users are ORG-scoped now, so drop memberships then the org itself (which
    // cascades to the workspace AND its users).
    d.workspaceMember.deleteMany({ where: { workspaceId } }),
    d.workspace.deleteMany({ where: { id: workspaceId } }),
    d.organization.deleteMany({ where: { id: `${META_TEST_TEAM_ID}_org` } }),
  ]);
}

// ─── Webhook posting (HMAC-signed, like real Meta) ─────────────────────────

/**
 * POST a Meta webhook to the test api exactly as Meta would: the signature is
 * HMAC-SHA256 over the RAW body bytes, so we sign the exact string we send.
 */
export async function postMetaWebhook(
  workspaceId: string,
  payload: unknown,
  opts: { secret?: string; signature?: string } = {},
): Promise<{ status: number; text: string }> {
  const raw = JSON.stringify(payload);
  const secret = opts.secret ?? APP_SECRET;
  const sig = opts.signature ?? `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const res = await fetch(`${META_API_BASE}/webhooks/meta/${workspaceId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
  return { status: res.status, text: await res.text() };
}

/** The unauthenticated Meta subscription-verify GET (`hub.challenge` echo). */
export async function getWebhookVerify(
  workspaceId: string,
  token: string,
  challenge = "challenge123",
): Promise<{ status: number; text: string }> {
  const qs = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": token,
    "hub.challenge": challenge,
  });
  const res = await fetch(`${META_API_BASE}/webhooks/meta/${workspaceId}?${qs.toString()}`);
  return { status: res.status, text: await res.text() };
}

// ─── Social webhook payload builders (`object: page | instagram`) ──────────

type SocialObject = "page" | "instagram";

interface InboundOpts {
  object: SocialObject;
  /** Page/IG account id (recipient of the inbound). */
  accountId: string;
  /** Customer PSID / IGSID. */
  senderId: string;
  mid: string;
  text?: string;
  timestamp?: number;
  replyToMid?: string;
  attachment?: { type: "image" | "video" | "audio" | "file"; url: string };
}

/** Inbound customer message (text and/or attachment, optional quoted reply). */
export function socialInbound(o: InboundOpts): unknown {
  const message: Record<string, unknown> = { mid: o.mid };
  if (o.text != null) message.text = o.text;
  if (o.attachment) {
    message.attachments = [{ type: o.attachment.type, payload: { url: o.attachment.url } }];
  }
  if (o.replyToMid) message.reply_to = { mid: o.replyToMid };
  return {
    object: o.object,
    entry: [
      {
        id: o.accountId,
        time: o.timestamp ?? Date.now(),
        messaging: [
          {
            sender: { id: o.senderId },
            recipient: { id: o.accountId },
            timestamp: o.timestamp ?? Date.now(),
            message,
          },
        ],
      },
    ],
  };
}

/** A `read` receipt. Messenger uses `watermark`; Instagram a per-message `mid`. */
export function socialRead(o: {
  object: SocialObject;
  accountId: string;
  senderId: string;
  watermark?: number;
  mid?: string;
}): unknown {
  const read: Record<string, unknown> = {};
  if (o.watermark != null) read.watermark = o.watermark;
  if (o.mid != null) read.mid = o.mid;
  return {
    object: o.object,
    entry: [
      {
        id: o.accountId,
        time: Date.now(),
        messaging: [
          { sender: { id: o.senderId }, recipient: { id: o.accountId }, timestamp: Date.now(), read },
        ],
      },
    ],
  };
}

// ─── Messenger Calling webhook builders (`entry.calls[]`) ──────────────────

/** A consumer- or business-initiated `connect` call webhook. */
export function socialCallConnect(o: {
  object: SocialObject;
  accountId: string;
  callId: string;
  psid: string;
  direction?: "user_initiated" | "business_initiated";
}): unknown {
  const ts = Math.floor(Date.now() / 1000);
  return {
    object: o.object,
    entry: [
      {
        id: o.accountId,
        time: ts,
        calls: [
          {
            id: o.callId,
            to: o.accountId,
            from: o.psid,
            event: "connect",
            timestamp: ts,
            call_direction: o.direction ?? "user_initiated",
          },
        ],
      },
    ],
  };
}

/** A `terminate` webhook for an existing call (carries no caller id). */
export function socialCallTerminate(o: {
  object: SocialObject;
  accountId: string;
  callId: string;
  status?: "Completed" | "Failed";
  durationSeconds?: number;
}): unknown {
  const ts = Math.floor(Date.now() / 1000);
  const duration = o.durationSeconds ?? 0;
  return {
    object: o.object,
    entry: [
      {
        id: o.accountId,
        time: ts,
        calls: [
          {
            id: o.callId,
            event: "terminate",
            timestamp: ts,
            status: o.status ?? "Completed",
            start_time: ts - duration,
            end_time: ts,
            duration,
          },
        ],
      },
    ],
  };
}

// ─── Mock Graph control plane ──────────────────────────────────────────────

export interface MockCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  authorization?: string;
  at: number;
}

export async function resetMock(): Promise<void> {
  await fetch(`${GRAPH_MOCK_BASE}/__mock/reset`, { method: "POST" });
}

export async function mockCalls(): Promise<MockCall[]> {
  const res = await fetch(`${GRAPH_MOCK_BASE}/__mock/calls`);
  const json = (await res.json()) as { calls: MockCall[] };
  return json.calls;
}

/** The recorded Graph `/messages` sends (the outbound wire shapes). */
export async function mockSends(): Promise<MockCall[]> {
  return (await mockCalls()).filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
}

/**
 * WHICH account a recorded Graph call went out on.
 *
 * Meta's send path is `/{version}/{account-id}/messages` — the phone-number id
 * for WhatsApp, the Page id for Messenger/Instagram. So the account is already
 * on the wire and needs no extra instrumentation: this just names it, because
 * "the send used the right number" is the single assertion every multi-account
 * spec needs and reading `path.split("/")[2]` inline in twenty places would
 * make each of them quietly wrong the day the path shape changes.
 */
export function sendAccountId(call: MockCall): string | null {
  const segments = call.path.split("/").filter(Boolean);
  // [version, accountId, "messages"] — the id sits second from the end.
  return segments.length >= 2 ? (segments[segments.length - 2] ?? null) : null;
}

/** Every account id that a send actually went out on, in call order. */
export async function sendAccountIds(): Promise<string[]> {
  return (await mockSends())
    .map(sendAccountId)
    .filter((id): id is string => typeof id === "string");
}

// ─── /v1 send driver (API-key auth, session-independent) ───────────────────

export async function v1Send(
  apiToken: string,
  conversationId: string,
  body: { body: string; replyToMessageId?: string },
  idempotencyKey: string,
): Promise<{ status: number; json: any }> {
  // In prod Caddy aliases /v1/* → /api/external/v1/*; hitting the api directly
  // we use the real controller mount.
  const res = await fetch(`${META_API_BASE}/api/external/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`,
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text };
  }
  return { status: res.status, json };
}

// ─── Seeding a social contact + conversation directly (for send/UI specs) ──

export async function seedSocialConversation(o: {
  workspaceId: string;
  channel: "whatsapp" | "messenger" | "instagram";
  externalContactId?: string;
  phoneNumber?: string;
  name: string;
  lastInboundAt?: Date | null;
}): Promise<{ contactId: string; conversationId: string }> {
  const d = db();
  const contact = await d.contact.create({
    data: {
      workspaceId: o.workspaceId,
      name: o.name,
      identityChannel: o.channel,
      externalContactId: o.externalContactId ?? null,
      phoneNumber: o.phoneNumber ?? null,
      lastInboundAt: o.lastInboundAt === undefined ? new Date() : o.lastInboundAt,
    },
    select: { id: true },
  });
  const conversation = await d.conversation.create({
    data: {
      workspaceId: o.workspaceId,
      contactId: contact.id,
      channel: o.channel,
      status: "open",
      lastMessagePreview: "",
    },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: conversation.id };
}

/** POST /v1/conversations/:id/interactive — buttons / list / consent chips. */
export async function v1SendInteractive(
  apiToken: string,
  conversationId: string,
  body: {
    body: string;
    kind: "buttons" | "list";
    options: Array<{ id: string; title: string; description?: string }>;
    listCtaLabel?: string;
    contactShare?: Array<"phone" | "email">;
  },
  idempotencyKey: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(
    `${META_API_BASE}/api/external/v1/conversations/${conversationId}/interactive`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text };
  }
  return { status: res.status, json };
}

/**
 * Arm the mock Graph to fail the NEXT send with `status` (default 500), then
 * behave normally. Drives the ambiguous-send path: with a 5xx, Meta may or may
 * not have delivered, so the idempotency claim must be RETAINED.
 */
export async function failNextMetaSend(status = 500, count = 1): Promise<void> {
  await fetch(`${GRAPH_MOCK_BASE}/__mock/fail-next-send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, count }),
  });
}
