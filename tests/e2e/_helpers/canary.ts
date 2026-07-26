/**
 * The isolation canary.
 *
 * A tiny, realistic tenant — org, workspace, user, contact, conversation,
 * message, API key, webhook, workflow — with deliberately NON-`e2e-` ids, so
 * it looks exactly like the maintainer's real data to every cleanup path.
 * The setup plants it (idempotently) and fingerprints it; the global teardown
 * re-fingerprints and FAILS THE RUN on any drift.
 *
 * This is the permanent tripwire for the 2026-07-26 class of accident:
 * `wipeTestData()` used to be 14 unfiltered `deleteMany({})` calls that
 * destroyed real tenants on the shared dev database. If a spec (or a future
 * helper) ever deletes outside the `e2e-` namespace again, this fails loudly
 * instead of silently eating someone's inbox.
 *
 * The rows persist across runs on purpose — they are cheap (9 rows) and their
 * survival IS the assertion.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { db } from "./db";

export const CANARY_ORG_ID = "canary-org";
export const CANARY_WS_ID = "canary-ws";
const CANARY_USER_EMAIL = "canary-user@loadless.test";
export const FINGERPRINT_FILE = "tests/e2e/.auth/canary-fingerprint.json";

/** Plant the canary tenant if missing. Never updates existing rows — the whole
 *  point is that NOTHING writes to them after creation. */
export async function ensureCanary(): Promise<void> {
  const d = db();
  await d.organization.upsert({
    where: { id: CANARY_ORG_ID },
    create: { id: CANARY_ORG_ID, name: "Canary Org (do not touch)", status: "active" },
    update: {},
  });
  await d.workspace.upsert({
    where: { id: CANARY_WS_ID },
    create: { id: CANARY_WS_ID, name: "Canary Workspace", organizationId: CANARY_ORG_ID },
    update: {},
  });
  const user =
    (await d.user.findFirst({ where: { email: CANARY_USER_EMAIL }, select: { id: true } })) ??
    (await d.user.create({
      data: {
        organizationId: CANARY_ORG_ID,
        name: "Canary User",
        email: CANARY_USER_EMAIL,
        emailVerified: true,
      },
      select: { id: true },
    }));
  await d.workspaceMember.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: CANARY_WS_ID } },
    create: { userId: user.id, workspaceId: CANARY_WS_ID, role: "admin" },
    update: {},
  });

  const contact =
    (await d.contact.findFirst({
      where: { workspaceId: CANARY_WS_ID },
      select: { id: true },
    })) ??
    (await d.contact.create({
      data: {
        workspaceId: CANARY_WS_ID,
        name: "Canary Contact",
        identityChannel: "whatsapp",
        phoneNumber: "10000000001",
      },
      select: { id: true },
    }));
  const conversation =
    (await d.conversation.findFirst({
      where: { workspaceId: CANARY_WS_ID, contactId: contact.id },
      select: { id: true },
    })) ??
    (await d.conversation.create({
      data: {
        workspaceId: CANARY_WS_ID,
        contactId: contact.id,
        channel: "whatsapp",
        status: "open",
        lastMessagePreview: "canary",
      },
      select: { id: true },
    }));
  if (
    !(await d.message.findFirst({
      where: { workspaceId: CANARY_WS_ID },
      select: { id: true },
    }))
  ) {
    await d.message.create({
      data: {
        workspaceId: CANARY_WS_ID,
        conversationId: conversation.id,
        channel: "whatsapp",
        direction: "in",
        body: "canary message — must survive every e2e run",
        externalId: "canary-msg-1",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    });
  }
  if (
    !(await d.workspaceApiKey.findFirst({
      where: { workspaceId: CANARY_WS_ID },
      select: { id: true },
    }))
  ) {
    await d.workspaceApiKey.create({
      data: {
        workspaceId: CANARY_WS_ID,
        name: "canary-key",
        // A real-looking but unusable hash — the canary key is never presented.
        tokenHash: createHash("sha256").update("canary").digest("hex"),
        tokenPrefix: "canary_",
        createdById: user.id,
        scopes: ["read:contacts"],
      },
    });
  }
  if (
    !(await d.outboundWebhook.findFirst({
      where: { workspaceId: CANARY_WS_ID },
      select: { id: true },
    }))
  ) {
    await d.outboundWebhook.create({
      data: {
        workspaceId: CANARY_WS_ID,
        name: "canary-hook",
        url: "https://canary.invalid/hook",
        // Disabled so the delivery worker never actually posts anywhere.
        enabled: false,
        eventTypes: ["message.received"],
        secret: "canary-secret",
        createdById: user.id,
      },
    });
  }
  if (
    !(await d.workflow.findFirst({
      where: { workspaceId: CANARY_WS_ID },
      select: { id: true },
    }))
  ) {
    await d.workflow.create({
      data: {
        workspaceId: CANARY_WS_ID,
        name: "Canary workflow",
        // Unpublished draft: the dispatcher never picks it up.
        published: false,
        trigger: "message_received",
        triggerConfig: {},
        graph: { startNodeId: "", nodes: [], edges: [] },
      },
    });
  }
}

/** Deterministic digest of every canary row the wipe used to destroy. */
export async function canaryFingerprint(): Promise<string> {
  const d = db();
  const ws = { workspaceId: CANARY_WS_ID };
  const [org, workspace, users, contacts, conversations, messages, apiKeys, webhooks, workflows] =
    await Promise.all([
      d.organization.findUnique({ where: { id: CANARY_ORG_ID }, select: { id: true, name: true, status: true } }),
      d.workspace.findUnique({ where: { id: CANARY_WS_ID }, select: { id: true, name: true } }),
      d.user.findMany({ where: { organizationId: CANARY_ORG_ID }, select: { id: true, email: true }, orderBy: { id: "asc" } }),
      d.contact.findMany({ where: ws, select: { id: true, name: true, phoneNumber: true }, orderBy: { id: "asc" } }),
      d.conversation.findMany({ where: ws, select: { id: true, status: true }, orderBy: { id: "asc" } }),
      d.message.findMany({ where: ws, select: { id: true, body: true, externalId: true }, orderBy: { id: "asc" } }),
      d.workspaceApiKey.findMany({ where: ws, select: { id: true, name: true, tokenPrefix: true }, orderBy: { id: "asc" } }),
      d.outboundWebhook.findMany({ where: ws, select: { id: true, url: true }, orderBy: { id: "asc" } }),
      d.workflow.findMany({ where: ws, select: { id: true, name: true }, orderBy: { id: "asc" } }),
    ]);
  return createHash("sha256")
    .update(
      JSON.stringify({ org, workspace, users, contacts, conversations, messages, apiKeys, webhooks, workflows }),
    )
    .digest("hex");
}

export function writeFingerprint(hash: string): void {
  mkdirSync(dirname(FINGERPRINT_FILE), { recursive: true });
  writeFileSync(FINGERPRINT_FILE, JSON.stringify({ hash, at: new Date().toISOString() }, null, 2));
}

export function readFingerprint(): string | null {
  try {
    return (JSON.parse(readFileSync(FINGERPRINT_FILE, "utf8")) as { hash: string }).hash;
  } catch {
    return null;
  }
}
