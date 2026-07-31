import type { PrismaClient } from "@prisma/client";

import type { TicketAttachment } from "@ccp/shared/tickets/types";
import { blobStorage } from "@/lib/blob-storage";
import { kickOutbox } from "@/lib/events/outbox";
import { kindFromMime, normalizeMimeType } from "@/lib/media-storage";

import { ticketByIdWhere } from "./access";
import {
  bumpOpenTicketCount,
  publishTicketEvent,
  readTicket,
  writeTicketEvent,
  type TicketActor,
} from "./mutations";
import { ATTACHMENT_SELECT_FIELDS, mapAttachment } from "./queries";

/**
 * Files on a ticket — the screenshot of the error, the invoice, the signed form.
 *
 * The point of a ticket is that it carries everything the issue needs, so an
 * attachment is visible to every workspace the ticket is shared with, and reads
 * go through the SAME access gate as the ticket itself (`ticketByIdWhere`) —
 * never a bare `workspaceId` filter, which would hide a guest department's own
 * uploads from it.
 *
 * Bytes are streamed same-origin out of `GET /api/tickets/:id/attachments/:aid`
 * (never a presigned storage URL handed to the browser), so the gate applies to
 * every byte and a leaked link expires with the session rather than in a week.
 */

type Db = Pick<
  PrismaClient,
  "ticket" | "ticketEvent" | "ticketAttachment" | "conversation" | "$transaction"
>;

/** Total files per ticket. A ticket is a work item, not a file share; the cap
 *  keeps one runaway thread from dominating the bucket and the detail page. */
export const MAX_TICKET_ATTACHMENTS = 20;

export type AddAttachmentOutcome =
  | { ok: true; attachment: TicketAttachment }
  | { ok: false; reason: "ticket_not_found" }
  | { ok: false; reason: "too_many_attachments" }
  | { ok: false; reason: "unsupported_type" };

export interface AddAttachmentArgs {
  workspaceId: string;
  ticketId: string;
  actor: TicketActor;
  /** The THREAD message this file came in with, or omitted for a file attached
   *  directly to the ticket. */
  messageId?: string | null;
  bytes: Buffer;
  filename: string;
  mimeType: string;
}

/**
 * Store a file and attach it to a ticket.
 *
 * The blob is written FIRST and the row second: a row pointing at bytes that
 * never landed renders as a broken file forever, while bytes with no row are
 * merely garbage the orphan sweeper reclaims (and `TicketAttachment.blobKey` is
 * registered in its cross-check, so a LIVE attachment is never collected — four
 * historical incidents came from omitting exactly that).
 */
export async function addTicketAttachment(
  db: Db,
  args: AddAttachmentArgs,
): Promise<AddAttachmentOutcome> {
  const ticket = await db.ticket.findFirst({
    where: ticketByIdWhere(args.workspaceId, args.ticketId),
    select: {
      id: true,
      workspaceId: true,
      conversationId: true,
      _count: { select: { attachments: true } },
    },
  });
  if (!ticket) return { ok: false, reason: "ticket_not_found" };
  if (ticket._count.attachments >= MAX_TICKET_ATTACHMENTS) {
    return { ok: false, reason: "too_many_attachments" };
  }

  const mimeType = normalizeMimeType(args.mimeType);
  const kind = kindFromMime(mimeType);

  // The provider applies the mime allowlist AND a magic-byte sniff, so a
  // renamed executable claiming to be a PDF is refused at the boundary rather
  // than stored and served back same-origin. That refusal THROWS, so it is
  // translated into the typed outcome here — the domain layer never leaks a
  // provider exception to its callers.
  let blob;
  try {
    blob = await blobStorage.upload({
    bytes: args.bytes,
    mimeType,
    kind,
    context: {
      // The OWNING workspace's media prefix, not the uploader's: the file
      // belongs to the ticket, and every tenant-scope check downstream
      // (`isOwnTeamMediaUrl`, the widget gate) reads `media/{workspaceId}/`.
      workspaceId: ticket.workspaceId,
      direction: "out",
      externalId: `tkt-${ticket.id}`,
    },
    });
  } catch {
    return { ok: false, reason: "unsupported_type" };
  }

  const attachment = await db.$transaction(async (tx) => {
    const row = await tx.ticketAttachment.create({
      data: {
        // The UPLOADER's workspace — attribution on a shared ticket ("added by
        // Billing"), not the read scope.
        workspaceId: args.workspaceId,
        ticketId: ticket.id,
        messageId: args.messageId ?? null,
        blobKey: blob.key,
        blobUrl: blob.url,
        filename: args.filename.slice(0, 260),
        mimeType,
        kind,
        sizeBytes: blob.sizeBytes,
        uploadedById: args.actor.userId ?? null,
      },
      select: ATTACHMENT_SELECT_FIELDS,
    });

    // A file that arrived WITH a thread message is already announced by that
    // message — a log line for the same act is the timeline noise the history
    // exists to avoid, and it would show up in the wrong place besides. Only a
    // ticket-LEVEL file earns an entry.
    if (!args.messageId) {
      await writeTicketEvent(tx, ticket.workspaceId, ticket.id, "attachment_added", args.actor, null, {
        attachmentId: row.id,
        // Snapshotted so the log still reads after the file is deleted.
        filename: row.filename,
        sizeBytes: row.sizeBytes,
        kind: row.kind,
      });
      const mapped = await readTicket(tx, ticket.id);
      const openTicketCount = ticket.conversationId
        ? await bumpOpenTicketCount(tx, ticket.conversationId, 0)
        : 0;
      await publishTicketEvent(tx, {
        args: {
          workspaceId: ticket.workspaceId,
          actor: args.actor,
          silent: true,
          skipOutboundWebhook: true,
        },
        ticket: mapped,
        openTicketCount,
        action: "escalation_update",
        previousStatus: mapped.status,
      });
    }
    return row;
  });
  kickOutbox();
  return { ok: true, attachment: mapAttachment(attachment, ticket.id) };
}

export type AttachmentBytes =
  | { ok: true; blobKey: string; filename: string; mimeType: string }
  | { ok: false; reason: "not_found" };

/** Resolve an attachment for streaming, through the ticket's access gate. */
export async function getTicketAttachmentForRead(
  db: Db,
  workspaceId: string,
  ticketId: string,
  attachmentId: string,
): Promise<AttachmentBytes> {
  const row = await db.ticketAttachment.findFirst({
    where: {
      id: attachmentId,
      ticketId,
      // The gate lives on the TICKET, so a guest department reads the owner's
      // uploads and vice versa — and nobody outside the share reads either.
      ticket: ticketByIdWhere(workspaceId, ticketId),
    },
    select: { blobKey: true, filename: true, mimeType: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  return { ok: true, ...row };
}

export type RemoveAttachmentOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "forbidden" };

/**
 * Remove an attachment.
 *
 * The uploader's own workspace may remove its file; so may the ticket's owner
 * (they answer for the record). A guest cannot delete another department's
 * evidence. The blob is deleted AFTER the row commits: a deleted blob with a
 * live row is a permanently broken file, while a live blob with no row is
 * garbage the sweeper reclaims.
 */
export async function removeTicketAttachment(
  db: Db,
  args: { workspaceId: string; ticketId: string; attachmentId: string; actor: TicketActor },
): Promise<RemoveAttachmentOutcome> {
  const row = await db.ticketAttachment.findFirst({
    where: {
      id: args.attachmentId,
      ticketId: args.ticketId,
      ticket: ticketByIdWhere(args.workspaceId, args.ticketId),
    },
    select: {
      id: true,
      blobKey: true,
      filename: true,
      workspaceId: true,
      ticket: { select: { id: true, workspaceId: true, conversationId: true } },
    },
  });
  if (!row) return { ok: false, reason: "not_found" };
  const isUploaderWorkspace = row.workspaceId === args.workspaceId;
  const isTicketOwner = row.ticket.workspaceId === args.workspaceId;
  if (!isUploaderWorkspace && !isTicketOwner) return { ok: false, reason: "forbidden" };

  await db.$transaction(async (tx) => {
    await tx.ticketAttachment.delete({ where: { id: row.id } });
    await writeTicketEvent(
      tx,
      row.ticket.workspaceId,
      row.ticket.id,
      "attachment_removed",
      args.actor,
      null,
      { attachmentId: row.id, filename: row.filename },
    );
    const mapped = await readTicket(tx, row.ticket.id);
    const openTicketCount = row.ticket.conversationId
      ? await bumpOpenTicketCount(tx, row.ticket.conversationId, 0)
      : 0;
    await publishTicketEvent(tx, {
      args: {
        workspaceId: row.ticket.workspaceId,
        actor: args.actor,
        silent: true,
        skipOutboundWebhook: true,
      },
      ticket: mapped,
      openTicketCount,
      action: "escalation_update",
      previousStatus: mapped.status,
    });
  });
  kickOutbox();
  // Best-effort, after commit: the provider's delete never throws, and a leaked
  // blob is the safe direction (the weekly orphan sweeper reclaims it).
  await blobStorage.delete(row.blobKey);
  return { ok: true };
}
