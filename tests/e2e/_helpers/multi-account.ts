/**
 * A workspace running TWO accounts on every live channel.
 *
 * WHY ITS OWN WORKSPACE, not a second account bolted onto the shared meta
 * fixture. Adding one there is not additive — it changes the semantics of the
 * whole suite. With two active accounts on a channel, a credential load that
 * names no account correctly REFUSES (`account-unresolved`) instead of falling
 * back to the default, so every existing spec that creates a conversation
 * without binding an account starts failing. That refusal is right; the shared
 * fixture is simply not the place to prove it. Measured, not assumed: bolting a
 * second Page onto the shared team turned `outbound-send.spec.ts` red on the
 * first run.
 *
 * So the two fixtures do different jobs:
 *   - the shared `seedMetaTestTeam` stays SINGLE-account and is the control:
 *     it must keep passing unchanged, which is what proves the multi-account
 *     work didn't regress the one-account experience;
 *   - this one is deliberately multi-account and is where cross-account leaks
 *     are hunted.
 *
 * The WhatsApp pair sits on DIFFERENT WABAs, which is what makes the
 * interesting half testable at all: templates, template analytics and the
 * broadcast WABA guard are WABA-scoped, so two numbers under one WABA would
 * exercise none of it. Messenger/Instagram have no equivalent — a Page IS the
 * account there.
 */
import type { Prisma } from "@prisma/client";

import { encryptSecret } from "../../../apps/api/src/lib/crypto/envelope-core";
import { generateApiKey } from "../../../apps/api/src/auth/api-key";
import { db } from "./db";
import { APP_SECRET, VERIFY_TOKEN } from "./meta";

/** Stable ids so a crashed run's leftovers are overwritten, not duplicated. */
export const MA_TEAM_ID = "e2e-multi-account-team";
const MA_ORG_ID = `${MA_TEAM_ID}_org`;
const MA_USER_ID = `${MA_TEAM_ID}_user`;

/** Account A is the DEFAULT on every channel; B never is. */
export const MA = {
  whatsapp: {
    a: { account: "e2e_ma_wa_a", waba: "e2e_ma_waba_a", label: "Sales line" },
    b: { account: "e2e_ma_wa_b", waba: "e2e_ma_waba_b", label: "Support line" },
  },
  messenger: {
    a: { account: "e2e_ma_page_a", label: "Sales Page" },
    b: { account: "e2e_ma_page_b", label: "Support Page" },
  },
  instagram: {
    a: { account: "e2e_ma_ig_a", page: "e2e_ma_ig_page_a", label: "Sales IG" },
    b: { account: "e2e_ma_ig_b", page: "e2e_ma_ig_page_b", label: "Support IG" },
  },
} as const;

/** Deterministic ChannelConnection row ids — bind without a lookup. */
export const MA_CONN = {
  whatsappA: `${MA_TEAM_ID}_conn_wa_a`,
  whatsappB: `${MA_TEAM_ID}_conn_wa_b`,
  messengerA: `${MA_TEAM_ID}_conn_msgr_a`,
  messengerB: `${MA_TEAM_ID}_conn_msgr_b`,
  instagramA: `${MA_TEAM_ID}_conn_ig_a`,
  instagramB: `${MA_TEAM_ID}_conn_ig_b`,
} as const;

export interface MultiAccountTeam {
  workspaceId: string;
  userId: string;
  apiToken: string;
}

interface AccountSpec {
  channel: "whatsapp" | "messenger" | "instagram";
  accountId: string;
  connId: string;
  isDefault: boolean;
  label: string;
  wabaId?: string;
  config: Prisma.InputJsonObject;
  secrets: Prisma.InputJsonObject;
}

function accountSpecs(): AccountSpec[] {
  const shared = { appSecret: encryptSecret(APP_SECRET) };
  return [
    {
      channel: "whatsapp",
      accountId: MA.whatsapp.a.account,
      connId: MA_CONN.whatsappA,
      isDefault: true,
      label: MA.whatsapp.a.label,
      wabaId: MA.whatsapp.a.waba,
      config: {
        phoneNumberId: MA.whatsapp.a.account,
        wabaId: MA.whatsapp.a.waba,
        verifyToken: VERIFY_TOKEN,
        // Display numbers differ so a UI label assertion can tell them apart.
        displayPhoneNumber: "+15550000001",
      },
      secrets: { accessToken: encryptSecret("ma_wa_token_a"), ...shared },
    },
    {
      channel: "whatsapp",
      accountId: MA.whatsapp.b.account,
      connId: MA_CONN.whatsappB,
      isDefault: false,
      label: MA.whatsapp.b.label,
      wabaId: MA.whatsapp.b.waba,
      config: {
        phoneNumberId: MA.whatsapp.b.account,
        wabaId: MA.whatsapp.b.waba,
        verifyToken: VERIFY_TOKEN,
        displayPhoneNumber: "+15550000002",
      },
      secrets: { accessToken: encryptSecret("ma_wa_token_b"), ...shared },
    },
    {
      channel: "messenger",
      accountId: MA.messenger.a.account,
      connId: MA_CONN.messengerA,
      isDefault: true,
      label: MA.messenger.a.label,
      config: { pageId: MA.messenger.a.account, pageName: MA.messenger.a.label, verifyToken: VERIFY_TOKEN },
      secrets: { pageAccessToken: encryptSecret("ma_page_token_a"), ...shared },
    },
    {
      channel: "messenger",
      accountId: MA.messenger.b.account,
      connId: MA_CONN.messengerB,
      isDefault: false,
      label: MA.messenger.b.label,
      config: { pageId: MA.messenger.b.account, pageName: MA.messenger.b.label, verifyToken: VERIFY_TOKEN },
      secrets: { pageAccessToken: encryptSecret("ma_page_token_b"), ...shared },
    },
    {
      channel: "instagram",
      accountId: MA.instagram.a.account,
      connId: MA_CONN.instagramA,
      isDefault: true,
      label: MA.instagram.a.label,
      config: {
        igId: MA.instagram.a.account,
        pageId: MA.instagram.a.page,
        igUsername: "ma_ig_a",
        verifyToken: VERIFY_TOKEN,
      },
      secrets: { igAccessToken: encryptSecret("ma_ig_token_a"), ...shared },
    },
    {
      channel: "instagram",
      accountId: MA.instagram.b.account,
      connId: MA_CONN.instagramB,
      isDefault: false,
      label: MA.instagram.b.label,
      config: {
        igId: MA.instagram.b.account,
        pageId: MA.instagram.b.page,
        igUsername: "ma_ig_b",
        verifyToken: VERIFY_TOKEN,
      },
      secrets: { igAccessToken: encryptSecret("ma_ig_token_b"), ...shared },
    },
  ];
}

/** Idempotently (re)create the two-accounts-per-channel workspace. */
export async function seedMultiAccountTeam(): Promise<MultiAccountTeam> {
  const d = db();

  await d.organization.upsert({
    where: { id: MA_ORG_ID },
    create: { id: MA_ORG_ID, name: "E2E Multi-Account Org", status: "active" },
    update: { status: "active" },
  });
  await d.workspace.upsert({
    where: { id: MA_TEAM_ID },
    create: { id: MA_TEAM_ID, name: "E2E Multi-Account Team", organizationId: MA_ORG_ID },
    update: { organizationId: MA_ORG_ID },
  });
  await d.user.upsert({
    where: { id: MA_USER_ID },
    create: {
      id: MA_USER_ID,
      organizationId: MA_ORG_ID,
      orgRole: "admin",
      name: "E2E Multi-Account User",
      email: "e2e-multi-account@loadless.test",
      // `resolveSession` refuses an unverified user, so without this every API
      // call from this fixture 403s `email_not_verified`.
      emailVerified: true,
    },
    update: { organizationId: MA_ORG_ID },
  });
  await d.workspaceMember.upsert({
    where: { userId_workspaceId: { userId: MA_USER_ID, workspaceId: MA_TEAM_ID } },
    create: { userId: MA_USER_ID, workspaceId: MA_TEAM_ID, role: "admin" },
    update: { role: "admin" },
  });

  // Shared Meta App connection — the preferred source for the HMAC secret.
  const metaConfig = { appId: "e2e_ma_app_id", verifyToken: VERIFY_TOKEN };
  const metaSecrets = {
    appSecret: encryptSecret(APP_SECRET),
    systemUserToken: encryptSecret("e2e_ma_system_user_token"),
  };
  await d.metaConnection.upsert({
    where: { workspaceId: MA_TEAM_ID },
    create: { workspaceId: MA_TEAM_ID, config: metaConfig, secrets: metaSecrets },
    update: { config: metaConfig, secrets: metaSecrets },
  });

  for (const c of accountSpecs()) {
    await d.$transaction(async (tx) => {
      // Only the default-claiming account demotes siblings — a NON-default one
      // must never touch the flag, or seeding B would leave the channel with no
      // default at all. (The partial unique index permits exactly one.)
      if (c.isDefault) {
        await tx.channelConnection.updateMany({
          where: {
            workspaceId: MA_TEAM_ID,
            channel: c.channel,
            isDefault: true,
            NOT: { externalAccountId: c.accountId },
          },
          data: { isDefault: false },
        });
      }
      await tx.channelConnection.upsert({
        where: {
          workspaceId_channel_externalAccountId: {
            workspaceId: MA_TEAM_ID,
            channel: c.channel,
            externalAccountId: c.accountId,
          },
        },
        create: {
          // Fixed id — the api caches provider config (connection id included)
          // for 60s, so a wipe + re-seed that minted a fresh cuid would leave
          // ingest resolving a deleted id (FK failure → fail-soft 200 with no
          // row: the classic meta-suite flake).
          id: c.connId,
          workspaceId: MA_TEAM_ID,
          channel: c.channel,
          externalAccountId: c.accountId,
          isDefault: c.isDefault,
          label: c.label,
          ...(c.wabaId ? { wabaId: c.wabaId } : {}),
          config: c.config,
          secrets: c.secrets,
          isActive: true,
        },
        update: {
          isDefault: c.isDefault,
          label: c.label,
          ...(c.wabaId ? { wabaId: c.wabaId } : {}),
          config: c.config,
          secrets: c.secrets,
          isActive: true,
        },
      });
    });
  }

  // Deterministic default stage — `ensureDefaultStage` caches
  // (workspaceId → stage id), so letting the api mint a fresh one after a wipe
  // leaves every contact.create failing `Contact_stageId_fkey` against the
  // cached, deleted id.
  await d.contactStage.updateMany({
    where: { workspaceId: MA_TEAM_ID, isDefault: true, NOT: { id: `${MA_TEAM_ID}_stage` } },
    data: { isDefault: false },
  });
  await d.contactStage.upsert({
    where: { id: `${MA_TEAM_ID}_stage` },
    create: {
      id: `${MA_TEAM_ID}_stage`,
      workspaceId: MA_TEAM_ID,
      name: "New",
      color: "lime",
      position: 0,
      isDefault: true,
    },
    update: { isDefault: true },
  });

  // Auto-assignment OFF by default — the product default, and load-bearing for
  // this suite. A settings row left enabled by an earlier run made specs that
  // are not about routing generate assignment work that ran DETACHED from the
  // webhook response, then raced the routing spec's policy rebuild
  // (`skipped=not_found reason=picked`, `no_candidates` against a
  // just-deleted policy). The routing spec turns it on in its own beforeAll.
  await d.assignmentSettings.upsert({
    where: { workspaceId: MA_TEAM_ID },
    create: { workspaceId: MA_TEAM_ID, autoAssignOnNewConversation: false },
    update: { autoAssignOnNewConversation: false, autoAssignOnReopen: false },
  });
  // Same reasoning for the policies/rules a routing spec builds: leaving them
  // behind means an unrelated spec's inbound resolves a stale pool.
  await d.assignmentRule.deleteMany({ where: { workspaceId: MA_TEAM_ID } });
  await d.assignmentPolicyMember.deleteMany({ where: { workspaceId: MA_TEAM_ID } });
  await d.assignmentPolicy.deleteMany({ where: { workspaceId: MA_TEAM_ID } });

  // Unrestricted API key for `Authorization: Bearer` against the test api.
  const key = generateApiKey();
  await d.workspaceApiKey.deleteMany({ where: { workspaceId: MA_TEAM_ID } });
  await d.workspaceApiKey.create({
    data: {
      workspaceId: MA_TEAM_ID,
      name: "e2e multi-account key",
      tokenHash: key.tokenHash,
      tokenPrefix: key.tokenPrefix,
      scopes: ["*"],
      createdById: MA_USER_ID,
    },
  });

  return { workspaceId: MA_TEAM_ID, userId: MA_USER_ID, apiToken: key.token };
}

/**
 * A conversation BOUND to a specific account.
 *
 * The shared `seedSocialConversation` deliberately leaves `channelConnectionId`
 * null, which is fine on a single-account workspace and refuses outright here —
 * exactly as the product intends. Every multi-account spec must say which
 * account a thread belongs to, because that is the thing under test.
 */
export async function seedBoundConversation(o: {
  channel: "whatsapp" | "messenger" | "instagram";
  channelConnectionId: string;
  name: string;
  externalContactId?: string;
  phoneNumber?: string;
  lastInboundAt?: Date | null;
}): Promise<{ contactId: string; conversationId: string }> {
  const d = db();
  const contact = await d.contact.create({
    data: {
      workspaceId: MA_TEAM_ID,
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
      workspaceId: MA_TEAM_ID,
      contactId: contact.id,
      channel: o.channel,
      channelConnectionId: o.channelConnectionId,
      status: "open",
      lastMessagePreview: "",
    },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: conversation.id };
}

/** An APPROVED, zero-variable template in a specific WABA's catalog. */
export async function seedTemplate(o: {
  name: string;
  wabaId: string;
}): Promise<{ id: string }> {
  return db().messageTemplate.create({
    data: {
      workspaceId: MA_TEAM_ID,
      wabaId: o.wabaId,
      name: o.name,
      language: "en_US",
      status: "approved",
      category: "utility",
      externalId: `tpl_${o.wabaId}_${o.name}`,
      bodyText: "hello",
      components: [{ type: "BODY", text: "hello" }],
    },
    select: { id: true },
  });
}

/** A WhatsApp inbound webhook envelope addressed to a SPECIFIC number. */
export function waInboundTo(o: {
  phoneNumberId: string;
  wabaId: string;
  from: string;
  mid: string;
  text: string;
}): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: o.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              // THE routing key: which of our numbers the customer messaged.
              metadata: { phone_number_id: o.phoneNumberId },
              contacts: [{ wa_id: o.from, profile: { name: `WA ${o.from}` } }],
              messages: [
                {
                  from: o.from,
                  id: o.mid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: o.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Clear per-spec data but KEEP the accounts — mirrors the meta suite's rule
 *  that a mid-run connection delete strands the api's 60s config cache. */
export async function clearMultiAccountData(): Promise<void> {
  const d = db();
  const workspaceId = MA_TEAM_ID;
  await d.$transaction([
    d.outboundSendAttempt.deleteMany({ where: { workspaceId } }),
    d.apiIdempotencyKey.deleteMany({ where: { workspaceId } }),
    d.conversationEvent.deleteMany({ where: { workspaceId } }),
    // Outbound webhooks MUST be cleared between specs. A spec that registers one
    // (pointing at a deliberately unroutable URL) and leaves it behind makes
    // every later event fan out another bounded-retry delivery — seven of them
    // accumulated across runs and starved the assignment work past its poll
    // deadline, which read as "account routing is broken".
    d.outboundWebhookDelivery.deleteMany({ where: { webhook: { workspaceId } } }),
    d.outboundWebhook.deleteMany({ where: { workspaceId } }),
    d.message.deleteMany({ where: { workspaceId } }),
    d.broadcastRecipient.deleteMany({ where: { broadcast: { workspaceId } } }),
    d.broadcast.deleteMany({ where: { workspaceId } }),
    d.conversation.deleteMany({ where: { workspaceId } }),
    d.contact.deleteMany({ where: { workspaceId } }),
    d.messageTemplate.deleteMany({ where: { workspaceId } }),
  ]);
}

/** Drop everything this fixture created. Child → parent, in one tx. */
export async function wipeMultiAccountTeam(): Promise<void> {
  const d = db();
  const workspaceId = MA_TEAM_ID;
  await d.$transaction([
    d.outboundSendAttempt.deleteMany({ where: { workspaceId } }),
    d.apiIdempotencyKey.deleteMany({ where: { workspaceId } }),
    d.conversationEvent.deleteMany({ where: { workspaceId } }),
    d.internalNote.deleteMany({ where: { workspaceId } }),
    d.message.deleteMany({ where: { workspaceId } }),
    d.broadcastRecipient.deleteMany({ where: { broadcast: { workspaceId } } }),
    d.broadcast.deleteMany({ where: { workspaceId } }),
    d.conversation.deleteMany({ where: { workspaceId } }),
    d.contact.deleteMany({ where: { workspaceId } }),
    d.messageTemplate.deleteMany({ where: { workspaceId } }),
    d.workspaceApiKey.deleteMany({ where: { workspaceId } }),
    d.channelConnection.deleteMany({ where: { workspaceId } }),
    d.metaConnection.deleteMany({ where: { workspaceId } }),
    d.contactStage.deleteMany({ where: { workspaceId } }),
    d.workspaceMember.deleteMany({ where: { workspaceId } }),
    d.workspace.deleteMany({ where: { id: workspaceId } }),
    d.organization.deleteMany({ where: { id: MA_ORG_ID } }),
  ]);
}
