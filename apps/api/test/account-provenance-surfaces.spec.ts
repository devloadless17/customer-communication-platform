/**
 * The ACCOUNT must survive to every surface a human or an integration reads.
 *
 * `Conversation.channelConnectionId` is MUTABLE: ingest re-stamps it whenever
 * the customer writes to a different one of our numbers, because the live
 * thread — and the 24h window governing free-form replies — now belongs to that
 * account. Two surfaces silently failed to carry that:
 *
 *   1. The `message:new` socket frame. Nothing told an open inbox the thread had
 *      moved, so the list badge and thread header kept naming the OLD account —
 *      and the reply box, which scopes its template list by that id
 *      (`?accountId=`), kept offering templates from the previous account's
 *      WABA. Meta rejects those at send time.
 *   2. The contact CSV export. The directory can FILTER by account, so you could
 *      export "everyone on the Sales number" and get a file that never said
 *      Sales.
 *
 * Both are asserted against the DELIVERED artifact — the payload the emitter
 * actually receives, and the bytes actually written to the export file — not
 * the intermediate shape. A field that exists on the type, is set by the
 * publisher and appears in the docs sample can still be absent from what ships
 * (see channel-account-attribution-2026-07-28); only rendering the real
 * artifact catches that.
 *
 *   pnpm --filter @ccp/api exec vitest run test/account-provenance-surfaces.spec.ts
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

// The export runner uploads its artifact through the blob provider. Point it at
// a throwaway filesystem root so this spec exercises the REAL runner end to end
// without needing R2 credentials. Must be set before the module reads it.
const BLOB_ROOT = mkdtempSync(path.join(tmpdir(), "ccp-acct-spec-"));
process.env.BLOB_LOCAL_DIR = BLOB_ROOT;
process.env.BLOB_STORAGE_DRIVER = "local";

import { createTestPrismaClient } from "./_prisma";
import { setSharedDb } from "@/lib/db";
import { FANOUT_RULES } from "@/realtime/fanout-rules";
import { runContactExport } from "@/lib/contact-transfer/export-runner";
import { blobStorage } from "@/lib/blob-storage";

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `ap${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let salesId = "";
let supportId = "";
let contactId = "";
let conversationId = "";

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `AP Org ${S}` } });
  orgId = org.id;
  const ws = await prisma.workspace.create({
    data: { name: `AP WS ${S}`, organizationId: orgId },
  });
  workspaceId = ws.id;

  const mkAccount = async (suffix: string, label: string, phone: string, isDefault: boolean) =>
    (
      await prisma.channelConnection.create({
        data: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: `${S}_${suffix}`,
          label,
          isDefault,
          isActive: true,
          config: { displayPhoneNumber: phone },
        },
        select: { id: true },
      })
    ).id;

  // Support is the DEFAULT — so a surface that silently falls back to the
  // default reports Support, and the assertions below (which expect Sales)
  // fail loudly instead of passing on the fallback.
  supportId = await mkAccount("support", "Support", "+15550100001", true);
  salesId = await mkAccount("sales", "Sales", "+15550100002", false);

  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: "Hani Hamad",
      phoneNumber: "+9613442151",
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  contactId = contact.id;

  // The thread STARTED on Support and was re-stamped to Sales — exactly the
  // state a customer creates by messaging a second number of ours.
  const conv = await prisma.conversation.create({
    data: {
      workspaceId,
      contactId,
      channel: "whatsapp",
      channelConnectionId: salesId,
      status: "open",
      lastMessageAt: new Date(),
      lastMessagePreview: "hi",
    },
    select: { id: true },
  });
  conversationId = conv.id;
});

afterAll(async () => {
  if (orgId) {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  }
  await prisma.$disconnect().catch(() => undefined);
  rmSync(BLOB_ROOT, { recursive: true, force: true });
});

describe("the message:new frame", () => {
  /** Captures exactly what the emitter is handed — the delivered payload. */
  function captureFrame(event: Record<string, unknown>) {
    const frames: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const emitter = {
      emitAboutConversation: (
        _ws: string,
        _conv: string,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        frames.push({ event: name, payload });
      },
    };
    const rule = FANOUT_RULES["message.received"]!;
    rule(
      event as never,
      emitter as never,
    );
    return frames;
  }

  const baseEvent = (channelConnectionId: string | null) => ({
    workspaceId,
    conversationId,
    message: {
      id: "m1",
      conversationId,
      contactId,
      channel: "whatsapp",
      direction: "in",
      body: "hi",
      timestamp: new Date().toISOString(),
      status: "sent",
    },
    preview: "hi",
    lastMessageAt: new Date().toISOString(),
    unreadCount: 1,
    conversation: { id: conversationId, channel: "whatsapp", channelConnectionId },
    contact: { id: contactId, name: "Hani Hamad" },
  });

  it("carries the thread's account so an open inbox can follow a re-stamp", () => {
    const frames = captureFrame(baseEvent(salesId));
    const frame = frames.find((f) => f.event === "message:new");
    expect(frame, "no message:new frame emitted").toBeTruthy();
    // The whole point: the SALES id, not the workspace default (Support).
    expect(frame!.payload.channelConnectionId).toBe(salesId);
    expect(frame!.payload.channelConnectionId).not.toBe(supportId);
  });

  it("emits an explicit null rather than omitting it on an unbound thread", () => {
    const frames = captureFrame(baseEvent(null));
    const frame = frames.find((f) => f.event === "message:new")!;
    // `undefined` means "unchanged" to the reducers, which would leave a stale
    // account painted on a thread that genuinely has none. Null must be null.
    expect(frame.payload).toHaveProperty("channelConnectionId");
    expect(frame.payload.channelConnectionId).toBeNull();
  });
});

/** Drain a stored object back to text through the provider interface. */
async function readStoredText(key: string): Promise<string> {
  const obj = await blobStorage.getObject(key);
  const chunks: Buffer[] = [];
  for await (const chunk of obj.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("the contact export file", () => {
  it("names the account each person's thread is on", async () => {
    const result = await runContactExport({
      workspaceId,
      jobId: `${S}-job`,
      format: "csv",
      scope: { ids: [contactId] },
    });
    expect(result.rowCount).toBe(1);

    // Read the BYTES that were actually written, not the row objects that fed
    // the writer — the column has to survive header resolution and the CSV
    // sink, which is where an export-only column can quietly fall out.
    //
    // Read back THROUGH the provider interface, never by reconstructing the
    // driver's on-disk path: the local driver stores flat + encoded, and a spec
    // that reaches past the interface asserts the driver's private layout
    // instead of the contract (a call site doing exactly that is a defect this
    // repo has already had to fix twice).
    const csv = await readStoredText(result.artifactKey);
    const [header, firstRow] = csv.split(/\r?\n/);
    expect(header).toContain("channel_account");

    const cols = header!.split(",");
    const idx = cols.indexOf("channel_account");
    expect(idx).toBeGreaterThanOrEqual(0);
    // Naive split is safe here: the label has no comma. Asserting the LABEL
    // (not the cuid) is the point — a file full of database ids answers
    // "which account" only for someone with database access.
    const cell = firstRow!.split(",")[idx]!.replace(/^"|"$/g, "");
    expect(cell).toBe("Sales");
  });
});
