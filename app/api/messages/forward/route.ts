import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { getConversationWithRefs } from "@/lib/queries";
import { mediaPreview } from "@/lib/providers/ingest";
import { metaProvider, MetaSendError } from "@/lib/providers/meta";
import {
  getMetaSendConfig,
  ProviderNotConfiguredError,
} from "@/lib/providers/config";
import { emitToTeam } from "@/lib/socket-server";
import type {
  ConversationWithRefs,
  ForwardResult,
  MediaAttachment,
  MediaKind,
  Message,
} from "@/lib/types";

/**
 * Forward one or more existing messages from a thread to one or more contacts.
 *
 * Body: `{ messageIds: string[], contactIds: string[] }`
 *
 * For each target contact we reuse its latest non-closed conversation (or
 * open a fresh one — closed threads stay closed, same rule as inbound), then
 * re-send each source message in chronological order: text via `sendText`,
 * media by re-uploading the bytes we kept on disk. Each send becomes a normal
 * outbound row attributed to the forwarding agent and is broadcast via
 * `message:new` so every open client (and the inbox list) updates live; when
 * we open a brand-new thread the first emit carries the full conversation row
 * so the inbox list can splice it in without a refetch.
 *
 * Meta gotchas surfaced, not swallowed: a target whose 24h customer-service
 * window is closed will reject free-form text/media (error 131047). We stop
 * that contact's loop on the first 131047 (every later send would fail too)
 * and report it back so the agent knows to send a template instead.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  messageIds?: unknown;
  contactIds?: unknown;
}

const MAX_MESSAGES = 30;
const MAX_CONTACTS = 20;

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v.filter((x): x is string => typeof x === "string" && x.length > 0),
    ),
  ];
}

function describeSendError(err: unknown): string {
  if (err instanceof MetaSendError) {
    if (/131047|re-engagement|24 hours/i.test(err.body)) {
      return "24-hour window closed — send a template to re-engage";
    }
    return `provider rejected the send: ${err.body.slice(0, 160)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function isWindowClosed(err: unknown): boolean {
  return err instanceof MetaSendError && /131047/.test(err.body);
}

const captionable = (kind: MediaKind) =>
  kind === "image" || kind === "video" || kind === "document";

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId, userId } = session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const messageIds = asStringList(raw.messageIds);
  const contactIds = asStringList(raw.contactIds);
  if (messageIds.length === 0 || contactIds.length === 0) {
    return NextResponse.json(
      { error: "messageIds and contactIds are both required" },
      { status: 400 },
    );
  }
  if (messageIds.length > MAX_MESSAGES) {
    return NextResponse.json(
      { error: `too many messages — max ${MAX_MESSAGES} per forward` },
      { status: 400 },
    );
  }
  if (contactIds.length > MAX_CONTACTS) {
    return NextResponse.json(
      { error: `too many recipients — max ${MAX_CONTACTS} per forward` },
      { status: 400 },
    );
  }

  // Source messages, team-scoped, oldest-first so the order is preserved in
  // the destination. Drop failed rows (no real wamid / never sent).
  const sourceRows = await db.message.findMany({
    where: { id: { in: messageIds }, teamId, status: { not: "failed" } },
    orderBy: { timestamp: "asc" },
  });
  if (sourceRows.length === 0) {
    return NextResponse.json(
      { error: "none of those messages can be forwarded" },
      { status: 400 },
    );
  }

  let sendConfig;
  try {
    sendConfig = await getMetaSendConfig(teamId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json(
        { error: "whatsapp not connected", detail: err.message },
        { status: 409 },
      );
    }
    throw err;
  }

  const contacts = await db.contact.findMany({
    where: { id: { in: contactIds }, teamId },
  });
  if (contacts.length === 0) {
    return NextResponse.json({ error: "no such contacts" }, { status: 404 });
  }

  // Fetch each source message's media bytes from the blob provider at most
  // once even when forwarding to several contacts. `null` is cached too — a
  // missing/unreadable file shouldn't be retried per recipient.
  type MediaBytes = {
    bytes: Uint8Array;
    mime: string;
    filename: string | null;
    kind: MediaKind;
  };
  const mediaCache = new Map<string, MediaBytes | null>();
  async function loadMediaBytes(
    m: (typeof sourceRows)[number],
  ): Promise<MediaBytes | null> {
    if (mediaCache.has(m.id)) return mediaCache.get(m.id)!;
    let entry: MediaBytes | null = null;
    // Prefer mediaUrl (the CDN URL — single hop). Falls back to mediaKey if
    // the row predates the URL column. Either path goes through the same
    // provider, so swapping S3 later doesn't touch this call site.
    const handle = m.mediaUrl ?? m.mediaKey;
    if (handle && m.mediaKind) {
      try {
        const fetched = await blobStorage.fetch(handle);
        entry = {
          bytes: fetched.bytes,
          mime: m.mediaMimeType ?? fetched.mimeType,
          filename: m.mediaFilename ?? null,
          kind: m.mediaKind as MediaKind,
        };
      } catch {
        entry = null;
      }
    }
    mediaCache.set(m.id, entry);
    return entry;
  }

  const teamRow = await db.team.findUnique({
    where: { id: teamId },
    select: { name: true },
  });

  const results: ForwardResult[] = [];

  for (const contact of contacts) {
    // Find-or-create the active conversation (mirrors inbound ingest /
    // broadcast send: reuse the latest non-closed thread, else open one).
    const existing = await db.conversation.findFirst({
      where: { teamId, contactId: contact.id, status: { not: "closed" } },
      orderBy: { lastMessageAt: "desc" },
    });
    const conversation =
      existing ??
      (await db.conversation.create({
        data: {
          teamId,
          contactId: contact.id,
          // New chats land in `pending` — matches the webhook ingest +
          // broadcast runner so every fresh thread starts in triage.
          status: "pending",
          lastMessagePreview: "",
        },
      }));
    const conversationIsNew = !existing;
    let emittedForConversation = false;

    // Broadcast a `message:new`; on the first send into a freshly-opened
    // thread, attach the full conversation row so the inbox list can splice
    // it in without refetching.
    async function emitForwarded(message: Message, preview: string, ts: string) {
      let newConversation: ConversationWithRefs | undefined;
      if (conversationIsNew && !emittedForConversation) {
        const refs = await getConversationWithRefs(teamId, conversation.id, {
          messageLimit: 1,
        });
        if (refs) newConversation = refs.data;
      }
      emittedForConversation = true;
      emitToTeam(teamId, "message:new", {
        teamId,
        conversationId: conversation.id,
        message,
        preview,
        lastMessageAt: ts,
        unreadDelta: 0,
        ...(newConversation ? { newConversation } : {}),
      });
    }

    let sent = 0;
    let failed = 0;
    let firstError: string | undefined;

    for (const src of sourceRows) {
      try {
        if (src.mediaKind) {
          const mb = await loadMediaBytes(src);
          if (!mb) {
            failed++;
            firstError ??= "a media file is no longer available";
            continue;
          }
          const caption =
            (src.mediaCaption ?? src.body ?? "").trim() || undefined;
          const filename = mb.filename ?? "upload";
          const withCaption = captionable(mb.kind) ? caption : undefined;

          const uploaded = await metaProvider.uploadMedia!(
            { bytes: mb.bytes, mimeType: mb.mime, filename },
            sendConfig,
          );
          const send = await metaProvider.sendMedia!(
            {
              to: contact.phoneNumber,
              kind: mb.kind,
              mediaId: uploaded.mediaId,
              caption: withCaption,
              filename: mb.kind === "document" ? filename : undefined,
            },
            sendConfig,
          );

          const saved = await blobStorage.upload({
            bytes: mb.bytes,
            mimeType: mb.mime,
            kind: mb.kind,
            context: {
              teamId,
              teamSlug: teamRow?.name,
              direction: "out",
              contactPhone: contact.phoneNumber,
              contactName: contact.name,
              conversationId: conversation.id,
              externalId: send.externalId,
              originalFilename: filename,
            },
          });
          const previewBody = (withCaption || mediaPreview(mb.kind)).slice(
            0,
            200,
          );

          const created = await db.message.create({
            data: {
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body: withCaption ?? "",
              direction: "out",
              provider: "meta_cloud",
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
                mediaId: uploaded.mediaId,
              } as Prisma.InputJsonValue,
              timestamp: send.timestamp,
              mediaKind: mb.kind,
              mediaKey: saved.key,
              mediaUrl: saved.url,
              mediaMimeType: mb.mime,
              mediaCaption: withCaption ?? null,
              mediaFilename: mb.kind === "document" ? filename : null,
              mediaSizeBytes: saved.sizeBytes,
            },
          });
          await db.conversation.update({
            where: { id: conversation.id },
            data: {
              lastMessageAt: send.timestamp,
              lastMessagePreview: previewBody,
            },
          });

          const media: MediaAttachment = {
            kind: mb.kind,
            url: `/api/media/${created.id}`,
            mimeType: mb.mime,
            sizeBytes: saved.sizeBytes,
            ...(withCaption ? { caption: withCaption } : {}),
            ...(mb.kind === "document" ? { filename } : {}),
          };
          const message: Message = {
            id: created.id,
            teamId,
            conversationId: conversation.id,
            externalId: send.externalId,
            senderUserId: userId,
            body: withCaption ?? "",
            direction: "out",
            provider: "meta_cloud",
            status: "sent",
            rawPayload: {
              sentVia: "api/messages/forward",
              forwardedFrom: src.id,
            },
            timestamp: send.timestamp.toISOString(),
            media,
          };
          await emitForwarded(message, previewBody, send.timestamp.toISOString());
        } else {
          const body = (src.body ?? "").trim();
          if (!body) continue; // nothing to forward (shouldn't happen)

          const send = await metaProvider.sendText(
            { to: contact.phoneNumber, body },
            sendConfig,
          );
          const created = await db.message.create({
            data: {
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body,
              direction: "out",
              provider: "meta_cloud",
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              } as Prisma.InputJsonValue,
              timestamp: send.timestamp,
            },
          });
          const preview = body.slice(0, 200);
          await db.conversation.update({
            where: { id: conversation.id },
            data: { lastMessageAt: send.timestamp, lastMessagePreview: preview },
          });

          const message: Message = {
            id: created.id,
            teamId,
            conversationId: conversation.id,
            externalId: send.externalId,
            senderUserId: userId,
            body,
            direction: "out",
            provider: "meta_cloud",
            status: "sent",
            rawPayload: {
              sentVia: "api/messages/forward",
              forwardedFrom: src.id,
            },
            timestamp: send.timestamp.toISOString(),
          };
          await emitForwarded(message, preview, send.timestamp.toISOString());
        }
        sent++;
      } catch (err) {
        failed++;
        firstError ??= describeSendError(err);
        if (!(err instanceof MetaSendError)) {
          console.error("[api/messages/forward] send failed", err);
        }
        // A closed window fails every remaining send for this contact —
        // don't hammer Meta with guaranteed-fail requests.
        if (isWindowClosed(err)) break;
      }
    }

    results.push({
      contactId: contact.id,
      contactName: contact.name,
      ok: failed === 0 && sent > 0,
      sent,
      failed,
      ...(firstError ? { error: firstError } : {}),
    });
  }

  return NextResponse.json({ results });
}
