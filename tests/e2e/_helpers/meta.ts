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

// Per-channel identity + token fixtures.
export const WA_PHONE_NUMBER_ID = "e2e_wa_phone_1";
export const WA_WABA_ID = "e2e_wa_waba_1";
export const WA_ACCESS_TOKEN = "e2e_wa_access_token";
export const MSGR_PAGE_ID = "e2e_msgr_page_1";
export const MSGR_PAGE_TOKEN = "e2e_msgr_page_token";
export const IG_ID = "e2e_ig_1";
export const IG_PAGE_ID = "e2e_ig_page_1";
export const IG_ACCESS_TOKEN = "e2e_ig_access_token";

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
      // EXPLICIT, not inherited. Auto-open is OFF by default (a ticket means
      // someone decided this needs work, not "a message arrived"), but the
      // ingest→ticket routing specs exercise the auto-open path specifically.
      // Pinning it here keeps them testing what they claim to test, and the
      // specs that assert the OFF behaviour flip it through the real settings
      // endpoint rather than relying on the default.
      ticketAutoOpen: true,
    },
    update: { organizationId: orgId, ticketAutoOpen: true },
  });

  await d.user.upsert({
    where: { id: META_TEST_USER_ID },
    create: {
      id: META_TEST_USER_ID,
      organizationId: orgId,
      orgRole: "admin",
      name: "E2E Meta User",
      email: "e2e-meta-user@loadless.test",
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
    config: Prisma.InputJsonObject;
    secrets: Prisma.InputJsonObject;
  }> = [
    {
      channel: "whatsapp",
      accountId: WA_PHONE_NUMBER_ID,
      config: { phoneNumberId: WA_PHONE_NUMBER_ID, wabaId: WA_WABA_ID, verifyToken: VERIFY_TOKEN },
      secrets: { accessToken: encryptSecret(WA_ACCESS_TOKEN), appSecret: encryptSecret(APP_SECRET) },
    },
    {
      channel: "messenger",
      accountId: MSGR_PAGE_ID,
      config: { pageId: MSGR_PAGE_ID, pageName: "Mock Page", verifyToken: VERIFY_TOKEN },
      secrets: { pageAccessToken: encryptSecret(MSGR_PAGE_TOKEN), appSecret: encryptSecret(APP_SECRET) },
    },
    {
      channel: "instagram",
      accountId: IG_ID,
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
      await tx.channelConnection.updateMany({
        where: {
          workspaceId: META_TEST_TEAM_ID,
          channel: c.channel,
          isDefault: true,
          NOT: { externalAccountId: c.accountId },
        },
        data: { isDefault: false },
      });
      await tx.channelConnection.upsert({
        where: {
          workspaceId_channel_externalAccountId: {
            workspaceId: META_TEST_TEAM_ID,
            channel: c.channel,
            externalAccountId: c.accountId,
          },
        },
        create: {
          workspaceId: META_TEST_TEAM_ID,
          channel: c.channel,
          externalAccountId: c.accountId,
          isDefault: true,
          ...(c.channel === "whatsapp" ? { wabaId: WA_WABA_ID } : {}),
          config: c.config,
          secrets: c.secrets,
          isActive: true,
        },
        update: { isDefault: true, config: c.config, secrets: c.secrets, isActive: true },
      });
    });
  }

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
