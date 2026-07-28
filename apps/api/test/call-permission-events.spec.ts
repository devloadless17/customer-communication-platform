/**
 * Call-permission visibility pills.
 *
 * The `call_permission_reply` webhook is consumed WHOLE into contact/request
 * state, so without a pill the customer's decision leaves no visible trace —
 * most importantly a "request a callback" tap outside call hours, which
 * arrives as nothing but an automatic grant. These tests pin the rules of
 * `recordCallPermissionActivity` (providers/ingest-call.ts):
 *
 *   - automatic grant with NO call on file → `callback_requested` pill +
 *     lastMessageAt bump + closed-thread reopen (missed-call triage posture);
 *   - redelivery of the same grant → NO second pill (transition-gated);
 *   - user_action grant answering our request → `call_permission_granted`;
 *   - automatic grant whose context names a call we ingested → NO pill
 *     (the CallBubble already tells that story);
 *   - user_action decline → `call_permission_declined`; automatic
 *     withdrawal → NO pill (provider bookkeeping, not a customer decision).
 *
 *   pnpm --filter @ccp/api exec vitest run test/call-permission-events.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { ingestCallEvent } from "@/lib/providers/ingest-call";
import type { NormalizedCallEvent } from "@ccp/shared/providers/types";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `cp${Date.now().toString().slice(-8)}`;

const T_OLD = new Date("2026-07-20T10:00:00.000Z"); // seeded lastMessageAt
const T_EVT = new Date("2026-07-26T09:30:00.000Z"); // permission webhook time

let workspaceId = "";
let seq = 0;

async function makeContactWithConversation(opts?: {
  status?: "open" | "closed";
}): Promise<{ contactId: string; conversationId: string; phone: string }> {
  seq += 1;
  const phone = `9613${Date.now().toString().slice(-6)}${seq}`;
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `Perm ${S}-${seq}`,
      identityChannel: "whatsapp",
      phoneNumber: phone,
    },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: opts?.status ?? "open",
      lastMessageAt: T_OLD,
    },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: conversation.id, phone };
}

function grantEvent(
  phone: string,
  opts?: {
    automatic?: boolean;
    requestExternalId?: string;
    permanent?: boolean;
  },
): NormalizedCallEvent {
  return {
    kind: "call",
    externalCallId: `perm:${opts?.requestExternalId ?? T_EVT.getTime()}`,
    contactPhone: phone,
    contactName: null,
    direction: "out",
    phase: "permission_granted",
    ...(opts?.permanent ? { permanentPermission: true } : {}),
    ...(opts?.requestExternalId
      ? { permissionRequestExternalId: opts.requestExternalId }
      : {}),
    ...(opts?.automatic ? { permissionAutomatic: true } : {}),
    timestamp: T_EVT,
    rawPayload: {},
  };
}

function revokeEvent(
  phone: string,
  opts?: { automatic?: boolean; requestExternalId?: string },
): NormalizedCallEvent {
  return {
    kind: "call",
    externalCallId: `perm:${opts?.requestExternalId ?? "revoke"}`,
    contactPhone: phone,
    contactName: null,
    direction: "out",
    phase: "permission_revoked",
    ...(opts?.requestExternalId
      ? { permissionRequestExternalId: opts.requestExternalId }
      : {}),
    ...(opts?.automatic ? { permissionAutomatic: true } : {}),
    timestamp: T_EVT,
    rawPayload: {},
  };
}

async function pills(conversationId: string) {
  return prisma.conversationEvent.findMany({
    where: {
      workspaceId,
      conversationId,
      kind: {
        in: [
          "callback_requested",
          "call_permission_granted",
          "call_permission_declined",
        ],
      },
    },
    orderBy: { at: "asc" },
    select: { kind: true, userId: true, at: true, after: true },
  });
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Perm Org ${S}`, status: "active" },
  });
  workspaceId = (
    await prisma.workspace.create({
      data: { name: `Perm WS ${S}`, organizationId: org.id },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$transaction([
    prisma.conversationEvent.deleteMany({ where: { workspaceId } }),
    prisma.callPermissionRequest.deleteMany({ where: { workspaceId } }),
    prisma.call.deleteMany({ where: { workspaceId } }),
    prisma.conversation.deleteMany({ where: { workspaceId } }),
    prisma.contact.deleteMany({ where: { workspaceId } }),
  ]);
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.$disconnect();
});

describe("call-permission visibility pills", () => {
  it("an automatic grant with no call on file writes a callback_requested pill, bumps lastMessageAt and reopens a closed thread", async () => {
    const { contactId, conversationId, phone } = await makeContactWithConversation({
      status: "closed",
    });

    await ingestCallEvent(workspaceId, "whatsapp", grantEvent(phone, { automatic: true }));

    const rows = await pills(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("callback_requested");
    // Customer actor — never attributed to a team user.
    expect(rows[0]!.userId).toBeNull();
    // Action-time anchoring (webhook time, not write time).
    expect(rows[0]!.at.toISOString()).toBe(T_EVT.toISOString());
    // Name snapshot rides `after` for the renderer.
    expect((rows[0]!.after as { contactId?: string }).contactId).toBe(contactId);

    const convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { status: true, lastMessageAt: true },
    });
    // Rises for triage exactly like a missed call.
    expect(convo.status).toBe("pending");
    expect(convo.lastMessageAt.toISOString()).toBe(T_EVT.toISOString());
  });

  it("an at-least-once redelivery of the same automatic grant writes NO second pill", async () => {
    const { contactId, conversationId, phone } = await makeContactWithConversation();

    await ingestCallEvent(workspaceId, "whatsapp", grantEvent(phone, { automatic: true }));
    await ingestCallEvent(workspaceId, "whatsapp", grantEvent(phone, { automatic: true }));

    const rows = await pills(conversationId);
    expect(rows).toHaveLength(1);
    // And the grant cache holds exactly one live row, not a duplicate.
    const grants = await prisma.callPermissionRequest.count({
      where: { workspaceId, contactId, status: "granted" },
    });
    expect(grants).toBe(1);
  });

  it("a user_action grant answering our request writes call_permission_granted and does NOT bump the thread", async () => {
    const { contactId, conversationId, phone } = await makeContactWithConversation();
    const reqId = `${S}_wamid_req_grant`;
    await prisma.callPermissionRequest.create({
      data: {
        workspaceId,
        contactId,
        externalRequestId: reqId,
        status: "pending",
        expiresAt: new Date(T_EVT.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await ingestCallEvent(
      workspaceId,
      "whatsapp",
      grantEvent(phone, { requestExternalId: reqId, permanent: true }),
    );

    const rows = await pills(conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("call_permission_granted");
    expect((rows[0]!.after as { isPermanent?: boolean }).isPermanent).toBe(true);

    const convo = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { lastMessageAt: true },
    });
    // A reply to OUR request is not customer-initiated outreach — no bump.
    expect(convo.lastMessageAt.toISOString()).toBe(T_OLD.toISOString());
  });

  it("an automatic grant whose context names an ingested call writes NO pill (the CallBubble tells that story)", async () => {
    const { conversationId, phone } = await makeContactWithConversation();
    const wacid = `${S}_wacid_ctx`;
    await prisma.call.create({
      data: {
        workspaceId,
        conversationId,
        externalCallId: wacid,
        direction: "in",
        status: "completed",
        ringingAt: T_EVT,
        answeredAt: T_EVT,
        rawPayload: {},
      },
    });

    await ingestCallEvent(
      workspaceId,
      "whatsapp",
      grantEvent(phone, { automatic: true, requestExternalId: wacid }),
    );

    expect(await pills(conversationId)).toHaveLength(0);
  });

  it("a user_action decline writes call_permission_declined; an automatic withdrawal writes NO pill", async () => {
    // Decline: the customer answered our request with "Don't allow".
    const declined = await makeContactWithConversation();
    const reqId = `${S}_wamid_req_decline`;
    await prisma.callPermissionRequest.create({
      data: {
        workspaceId,
        contactId: declined.contactId,
        externalRequestId: reqId,
        status: "pending",
        expiresAt: new Date(T_EVT.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    await ingestCallEvent(
      workspaceId,
      "whatsapp",
      revokeEvent(declined.phone, { requestExternalId: reqId }),
    );
    const declineRows = await pills(declined.conversationId);
    expect(declineRows).toHaveLength(1);
    expect(declineRows[0]!.kind).toBe("call_permission_declined");

    // Automatic withdrawal (too many unanswered calls): provider bookkeeping,
    // already explained by the contact panel's revoked-until notice — no pill.
    const withdrawn = await makeContactWithConversation();
    await prisma.callPermissionRequest.create({
      data: {
        workspaceId,
        contactId: withdrawn.contactId,
        status: "granted",
        grantedAt: T_OLD,
        expiresAt: new Date(T_EVT.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    await ingestCallEvent(
      workspaceId,
      "whatsapp",
      revokeEvent(withdrawn.phone, { automatic: true }),
    );
    expect(await pills(withdrawn.conversationId)).toHaveLength(0);
  });
});
