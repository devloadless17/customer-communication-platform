/**
 * The ticket-thread BACKFILL, run against real legacy rows.
 *
 * Why this exists: the dev database held ZERO `escalation_note` events when the
 * migration was written, so `20260731090100_ticket_thread_backfill` applied as a
 * no-op and proved nothing. Production has real ones — every cross-department
 * comment written since 2026-07-28. And the failure is SILENT in the worst way:
 * `listTicketEvents` now excludes the kind, so a comment the copy misses renders
 * in neither the log nor the thread. It is still in the table; it is simply
 * gone from the product.
 *
 * So: seed rows in exactly the legacy shape, run the migration's own SQL
 * verbatim (read from the file — a hand-retyped copy here would be a second
 * source of truth that drifts), and assert what the UI will actually show.
 *
 *   BLOB_STORAGE_DRIVER=local pnpm --filter @ccp/api exec vitest run test/ticket-thread-backfill.spec.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listTicketEvents } from "@/lib/tickets/queries";
import { listTicketThread } from "@/lib/tickets/thread";
import { createTicket } from "@/lib/tickets/mutations";
import { shareTicket } from "@/lib/tickets/shares";
import { setSharedDb } from "@/lib/db";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
const mdb = prisma as unknown as Parameters<typeof createTicket>[0];
const qdb = prisma as unknown as Parameters<typeof listTicketEvents>[0];
const tdb = prisma as unknown as Parameters<typeof listTicketThread>[0];
setSharedDb(prisma as unknown as PrismaClient);

const MIGRATION = join(
  process.cwd(),
  "../../prisma/migrations/20260731090100_ticket_thread_backfill/migration.sql",
);

const S = `bfl${Date.now().toString().slice(-8)}`;
let orgId = "";
let wsA = "";
let wsB = "";
let userId = "";
let ticketId = "";
/** The legacy comment event, whose id the migrated message must REUSE. */
let noteId = "";
let attachmentId = "";
let raiseAttachmentId = "";
let raiseEventId = "";

/**
 * The migration's own statements. Line comments are stripped BEFORE splitting:
 * the file's prose explains the cascade trap using backticks, and a comment
 * carried into the query is a Postgres syntax error, not a passing test.
 */
function backfillStatements(): string[] {
  const sql = readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `${s};`);
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `BFL Org ${S}`, status: "active" } }))
    .id;
  wsA = (await prisma.workspace.create({ data: { name: `BFL A ${S}`, organizationId: orgId } })).id;
  wsB = (await prisma.workspace.create({ data: { name: `BFL B ${S}`, organizationId: orgId } })).id;
  userId = (
    await prisma.user.create({
      data: { name: "BFL Agent", email: `bfl-${S}@example.test`, organizationId: orgId },
      select: { id: true },
    })
  ).id;
  for (const workspaceId of [wsA, wsB]) {
    await prisma.workspaceMember.create({ data: { userId, workspaceId, role: "agent" } });
  }

  const contact = await prisma.contact.create({
    data: {
      workspaceId: wsA,
      name: `BFL ${S}`,
      phoneNumber: `+9867${S.slice(3)}001`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  const convo = await prisma.conversation.create({
    data: { workspaceId: wsA, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  const created = await createTicket(mdb, {
    workspaceId: wsA,
    conversationId: convo.id,
    actor: { userId, workspaceId: wsA },
    source: "human",
    subject: "Legacy comment carrier",
  });
  if (!created.ok) throw new Error("seed ticket failed");
  ticketId = created.ticket.id;

  // A comment in EXACTLY the pre-2026-07-31 shape: a TicketEvent of kind
  // `escalation_note`, written by the GUEST workspace, carrying a file.
  const note = await prisma.ticketEvent.create({
    data: {
      workspaceId: wsA, // always the OWNER's, as the old writer stamped it
      ticketId,
      kind: "escalation_note",
      body: "Legacy: refund approved, 3-5 business days.",
      actorUserId: userId,
      actorWorkspaceId: wsB,
      createdAt: new Date("2026-07-29T09:15:00.000Z"),
    },
    select: { id: true },
  });
  noteId = note.id;
  attachmentId = (
    await prisma.ticketAttachment.create({
      data: {
        workspaceId: wsB,
        ticketId,
        eventId: noteId,
        filename: "legacy-receipt.png",
        mimeType: "image/png",
        kind: "image",
        sizeBytes: 123,
        blobKey: `legacy/${S}/receipt.png`,
        blobUrl: `local://legacy/${S}/receipt.png`,
        uploadedById: userId,
      },
      select: { id: true },
    })
  ).id;

  // A file on a NON-comment event — the raise-time attachment. It must be left
  // exactly alone, or the guard in the UPDATE is doing nothing.
  const raise = await prisma.ticketEvent.create({
    data: { workspaceId: wsA, ticketId, kind: "attachment_added", actorUserId: userId },
    select: { id: true },
  });
  raiseEventId = raise.id;
  raiseAttachmentId = (
    await prisma.ticketAttachment.create({
      data: {
        workspaceId: wsA,
        ticketId,
        eventId: raiseEventId,
        filename: "raise-time.png",
        mimeType: "image/png",
        kind: "image",
        sizeBytes: 456,
        blobKey: `legacy/${S}/raise.png`,
        blobUrl: `local://legacy/${S}/raise.png`,
        uploadedById: userId,
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("ticket-thread backfill", () => {
  it("moves every legacy comment into the thread, files and all", async () => {
    for (const sql of backfillStatements()) {
      await prisma.$executeRawUnsafe(sql);
    }

    // The comment now reads as a thread message — same id, same author, same
    // department, same timestamp. Losing the timestamp would reorder a
    // conversation people rely on to reconstruct what happened.
    const thread = await listTicketThread(tdb, wsA, ticketId);
    expect(thread).toHaveLength(1);
    const [migrated] = thread;
    if (!migrated) throw new Error("nothing migrated");
    expect(migrated.id).toBe(noteId);
    expect(migrated.body).toBe("Legacy: refund approved, 3-5 business days.");
    expect(migrated.authorUserId).toBe(userId);
    expect(migrated.authorWorkspaceId).toBe(wsB);
    expect(migrated.authorWorkspaceName).toBe(`BFL B ${S}`);
    expect(migrated.createdAt).toBe("2026-07-29T09:15:00.000Z");

    // Its file came with it, and renders in the thread rather than nowhere.
    expect(migrated.attachments.map((a) => a.id)).toEqual([attachmentId]);

    // The SOURCE event survives — deleting it would cascade its attachment row
    // away and the blob sweeper would bin the customer's file 24h later.
    expect(await prisma.ticketEvent.findUnique({ where: { id: noteId } })).not.toBeNull();
    // ...but it is out of the log, so the discussion isn't shown twice.
    const log = await listTicketEvents(qdb, wsA, ticketId);
    expect(log.some((e) => e.id === noteId)).toBe(false);

    // The raise-time file is untouched: still ticket-level, not claimed by a
    // message that does not exist.
    const raiseFile = await prisma.ticketAttachment.findUniqueOrThrow({
      where: { id: raiseAttachmentId },
      select: { messageId: true, eventId: true },
    });
    expect(raiseFile.messageId).toBeNull();
    expect(raiseFile.eventId).toBe(raiseEventId);
  });

  it("is safe to run twice — no duplicate messages, no re-pointed files", async () => {
    // Prisma marks a migration applied by checksum, but an operator re-running
    // it by hand (or a restore-then-replay) must not double the thread.
    for (const sql of backfillStatements()) {
      await prisma.$executeRawUnsafe(sql);
    }
    expect(await prisma.ticketMessage.count({ where: { ticketId } })).toBe(1);
    expect(await listTicketThread(tdb, wsA, ticketId)).toHaveLength(1);
    const file = await prisma.ticketAttachment.findUniqueOrThrow({
      where: { id: attachmentId },
      select: { messageId: true },
    });
    expect(file.messageId).toBe(noteId);
  });

  it("hands the migrated comment to the GUEST department too", async () => {
    // The whole reason these rows exist. A guest reading an empty thread where
    // the answer used to be is the failure this spec is here to prevent.
    const shared = await shareTicket(prisma as unknown as Parameters<typeof shareTicket>[0], {
      workspaceId: wsA,
      ticketId,
      actor: { userId, workspaceId: wsA },
      targetWorkspaceId: wsB,
      cause: "Billing must approve the refund",
    });
    expect(shared.ok).toBe(true);
    const guestThread = await listTicketThread(tdb, wsB, ticketId);
    expect(guestThread.map((m) => m.id)).toEqual([noteId]);
    expect(guestThread[0]?.attachments).toHaveLength(1);
  });
});
