/**
 * `resolveStepTarget` phone targets are WHATSAPP-scoped — both directions.
 *
 * A phone target must never resolve a social/widget sibling that merely
 * BORROWED the number (contact-share, public pre-chat box): delivering an
 * automation into an unverified thread is the impersonation vector the
 * 2026-08-10 audit closed. And the P2002 fallback leans on the
 * `Contact_workspaceId_phoneNumber_whatsapp_key` PARTIAL unique
 * (`WHERE phoneNumber IS NOT NULL AND identityChannel='whatsapp'`) — raw SQL
 * the toolchain cannot see (CLAUDE.md §18), so the ghost-revive path is
 * pinned here against the real database. Shipped 2026-08-11 with no coverage
 * (completeness review).
 *
 *   pnpm --filter @ccp/api exec vitest run test/workflow-target-phone-scope.spec.ts
 */
import { existsSync } from "node:fs";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { resolveStepTarget } from "@/lib/workflows/steps/target";
import type { WorkflowEventEnvelope } from "@/lib/workflows/events";
import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `wtp${Date.now() % 1e8}`;
const PHONE_BORROWED = `96170${(Date.now() % 1e6).toString().padStart(6, "0")}`;
const PHONE_WA = `96171${(Date.now() % 1e6).toString().padStart(6, "0")}`;
const PHONE_GHOST = `96172${(Date.now() % 1e6).toString().padStart(6, "0")}`;
let orgId = "";
let workspaceId = "";

const envelope = {} as WorkflowEventEnvelope; // unused by the phone branch

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `WTP Org ${S}`, status: "active" } })).id;
  workspaceId = (await prisma.workspace.create({ data: { name: `WTP WS ${S}`, organizationId: orgId } })).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("resolveStepTarget phone scope", () => {
  it("never resolves a WIDGET sibling that borrowed the phone — creates the WhatsApp identity", async () => {
    const widget = await prisma.contact.create({
      data: {
        workspaceId,
        name: "Widget visitor",
        identityChannel: "webchatwidget",
        externalContactId: `vis_${S}`,
        // The borrowed phone: typed into the public pre-chat box.
        phoneNumber: PHONE_BORROWED,
      },
      select: { id: true },
    });

    const resolved = await resolveStepTarget(
      { kind: "phone", phoneNumber: PHONE_BORROWED },
      envelope,
      workspaceId,
      { createConversation: false },
    );

    expect(resolved.contactId).not.toBe(widget.id);
    expect(resolved.contactCreated).toBe(true);
    const created = await prisma.contact.findUniqueOrThrow({
      where: { id: resolved.contactId },
      select: { identityChannel: true, phoneNumber: true },
    });
    expect(created.identityChannel).toBe("whatsapp");
    expect(created.phoneNumber).toBe(PHONE_BORROWED);
  });

  it("resolves an existing live WhatsApp contact without creating", async () => {
    const wa = await prisma.contact.create({
      data: { workspaceId, name: "WA person", identityChannel: "whatsapp", phoneNumber: PHONE_WA },
      select: { id: true },
    });
    const resolved = await resolveStepTarget(
      { kind: "phone", phoneNumber: PHONE_WA },
      envelope,
      workspaceId,
      { createConversation: false },
    );
    expect(resolved.contactId).toBe(wa.id);
    expect(resolved.contactCreated).toBe(false);
  });

  it("revives a soft-deleted ghost holding the whatsapp-scoped unique slot (P2002 fallback)", async () => {
    const ghost = await prisma.contact.create({
      data: {
        workspaceId,
        name: "Ghost",
        identityChannel: "whatsapp",
        phoneNumber: PHONE_GHOST,
        deletedAt: new Date(),
      },
      select: { id: true },
    });
    const resolved = await resolveStepTarget(
      { kind: "phone", phoneNumber: PHONE_GHOST },
      envelope,
      workspaceId,
      { createConversation: false },
    );
    expect(resolved.contactId).toBe(ghost.id);
    expect(resolved.contactCreated).toBe(true); // a revived ghost is a fresh directory appearance
    const revived = await prisma.contact.findUniqueOrThrow({
      where: { id: ghost.id },
      select: { deletedAt: true },
    });
    expect(revived.deletedAt).toBeNull();
  });
});
