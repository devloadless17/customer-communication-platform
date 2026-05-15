import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getConversationWithRefs } from "@/lib/queries";
import { mediaPreview } from "@/lib/providers/ingest";
import { getMetaProvider } from "@/lib/providers";
import { MetaSendError, normalizeMetaSendError } from "@/lib/providers/meta";
import {
  getMetaSendConfig,
  ProviderNotConfiguredError,
} from "@/lib/providers/config";
import { emitToTeam } from "@/lib/socket/server";
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

// Forwarding runs sequentially in the request handler (no BullMQ — that's the
// broadcast runner's job). Each Meta send is ~300ms, so the product cap is
// chosen to keep the worst case under the reverse-proxy idle timeout. Past
// these numbers users should use the broadcast feature instead.
const MAX_MESSAGES = 10;
const MAX_CONTACTS = 5;
const MAX_TOTAL_SENDS = 40;

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v.filter((x): x is string => typeof x === "string" && x.length > 0),
    ),
  ];
}

function describeSendError(err: unknown): string {
  const normalized = normalizeMetaSendError(err);
  if (normalized) return normalized.message;
  return err instanceof Error ? err.message : String(err);
}

function isWindowClosed(err: unknown): boolean {
  return normalizeMetaSendError(err)?.code === "outside_24h_window";
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
  if (messageIds.length * contactIds.length > MAX_TOTAL_SENDS) {
    return NextResponse.json(
      {
        error: `too many sends — max ${MAX_TOTAL_SENDS} messages × recipients per forward (use a broadcast for larger fan-outs)`,
      },
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
      // Two distinct failure scopes per iteration:
      //   - PRE-send (Meta upload + Meta send): a throw here is a real fail.
      //     Mark the recipient failed and continue (or break on a closed
      //     window).
      //   - POST-send (blob upload + DB row + emit): Meta has already
      //     delivered. A throw here would lie to the agent ("failed!") AND
      //     could be retried by the UI → duplicate. We log and mark `sent`
      //     so the customer-visible reality matches our report.
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

          // Pre-send: upload to Meta, then send. Either throwing here is a
          // legitimate failure — the message has NOT gone to the customer.
          const uploaded = await getMetaProvider().uploadMedia!(
            { bytes: mb.bytes, mimeType: mb.mime, filename },
            sendConfig,
          );
          const send = await getMetaProvider().sendMedia!(
            {
              to: contact.phoneNumber,
              kind: mb.kind,
              mediaId: uploaded.mediaId,
              caption: withCaption,
              filename: mb.kind === "document" ? filename : undefined,
            },
            sendConfig,
          );

          // ── Post-send: from here, every error is local-state-only. The
          // customer already has the message.
          const saved = await blobStorage
            .upload({
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
            })
            .catch((err) => {
              console.error(
                `[forward] blob upload failed after Meta send (wamid=${send.externalId})`,
                err,
              );
              return null;
            });
          const previewBody = (withCaption || mediaPreview(mb.kind)).slice(
            0,
            200,
          );

          const created = await createOutboundMessageIdempotent({
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
              ...(saved ? {} : { blobUploadFailed: true }),
            } as Prisma.InputJsonValue,
            timestamp: send.timestamp,
            mediaKind: mb.kind,
            ...(saved
              ? {
                  mediaKey: saved.key,
                  mediaUrl: saved.url,
                  mediaSizeBytes: saved.sizeBytes,
                }
              : {}),
            mediaMimeType: mb.mime,
            mediaCaption: withCaption ?? null,
            mediaFilename: mb.kind === "document" ? filename : null,
          }).catch((err): null => {
            console.error(
              `[forward] DB persist failed after Meta send (wamid=${send.externalId})`,
              err,
            );
            return null;
          });

          // Even if local persistence broke, count this recipient as sent —
          // Meta has confirmed the customer received the message. Skip the
          // emit + conversation bump; the inbox will catch up on next refresh.
          if (!created) {
            sent++;
            continue;
          }

          void db.conversation
            .update({
              where: { id: conversation.id },
              data: {
                lastMessageAt: send.timestamp,
                lastMessagePreview: previewBody,
              },
            })
            .catch((err) =>
              console.error(
                "[forward] deferred conversation.update failed",
                err,
              ),
            );

          const media: MediaAttachment | undefined = saved
            ? {
                kind: mb.kind,
                url: `/api/media/${created.id}`,
                mimeType: mb.mime,
                sizeBytes: saved.sizeBytes,
                ...(withCaption ? { caption: withCaption } : {}),
                ...(mb.kind === "document" ? { filename } : {}),
              }
            : undefined;
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
            ...(media ? { media } : {}),
          };
          await emitForwarded(message, previewBody, send.timestamp.toISOString()).catch(
            (err) =>
              console.error("[forward] emit failed (already sent)", err),
          );
        } else {
          const body = (src.body ?? "").trim();
          if (!body) continue; // nothing to forward (shouldn't happen)

          // Pre-send.
          const send = await getMetaProvider().sendText(
            { to: contact.phoneNumber, body },
            sendConfig,
          );

          // Post-send: best-effort persistence.
          const created = await createOutboundMessageIdempotent({
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
          }).catch((err): null => {
            console.error(
              `[forward] DB persist failed after Meta send (wamid=${send.externalId})`,
              err,
            );
            return null;
          });

          if (!created) {
            sent++;
            continue;
          }

          const preview = body.slice(0, 200);
          void db.conversation
            .update({
              where: { id: conversation.id },
              data: { lastMessageAt: send.timestamp, lastMessagePreview: preview },
            })
            .catch((err) =>
              console.error(
                "[forward] deferred conversation.update failed",
                err,
              ),
            );

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
          await emitForwarded(message, preview, send.timestamp.toISOString()).catch(
            (err) =>
              console.error("[forward] emit failed (already sent)", err),
          );
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
