import type { Message } from "@ccp/shared/types";

/**
 * The sanitized message shape delivered to a visitor's browser. Deliberately a
 * SUBSET of the internal `Message` — a visitor must never see assignee, internal
 * notes, other-channel data, senderUserId, or the raw payload. Media is referred
 * to by message id only; the widget builds the same-origin URL itself
 * (`/api/widget/media/:id?key=…&v=…`) so no signed URL leaks on the wire.
 */
export interface WidgetMessageFrame {
  id: string;
  /** Provider/local id; its suffix is the widget's clientMsgId, so the widget can
   *  reconcile its optimistic bubble against the echoed inbound frame. */
  externalId: string;
  direction: "in" | "out";
  body: string;
  status: string;
  createdAt: string;
  /** Display name of the agent who sent an outbound message (null for the
   *  visitor's own messages and for system/automation sends). Lets the widget
   *  render "Sarah replied" with an initial avatar. */
  senderName?: string | null;
  media?: {
    kind: string;
    mimeType: string;
    filename?: string;
    durationMs?: number;
    voice?: boolean;
    sizeBytes?: number;
    /** True when a video poster exists (widget requests `&thumb=1`). */
    hasThumbnail?: boolean;
  };
  replyTo?: {
    id: string;
    body: string;
    direction: "in" | "out";
    mediaKind?: string;
  };
  /** ISO time the message was deleted/unsent, else null. */
  deletedAt?: string | null;
  editedAt?: string | null;
}

/** Map an internal domain `Message` to the sanitized visitor frame. `senderName`
 *  is resolved by the caller (it's not on the domain Message) and only set for
 *  agent-authored outbound messages. */
export function frameFromMessage(
  m: Message,
  opts?: { senderName?: string | null },
): WidgetMessageFrame {
  const frame: WidgetMessageFrame = {
    id: m.id,
    externalId: m.externalId,
    direction: m.direction,
    body: m.body,
    status: m.status,
    createdAt: m.timestamp,
  };
  if (m.direction === "out" && opts?.senderName) frame.senderName = opts.senderName;
  if (m.media) {
    frame.media = {
      kind: m.media.kind,
      mimeType: m.media.mimeType,
      ...(m.media.filename ? { filename: m.media.filename } : {}),
      ...(m.media.durationMs != null ? { durationMs: m.media.durationMs } : {}),
      ...(m.media.voice ? { voice: true } : {}),
      ...(m.media.sizeBytes ? { sizeBytes: m.media.sizeBytes } : {}),
      ...(m.media.thumbnailUrl ? { hasThumbnail: true } : {}),
    };
  }
  if (m.replyTo) {
    frame.replyTo = {
      id: m.replyTo.id,
      body: m.replyTo.body,
      direction: m.replyTo.direction,
      ...(m.replyTo.mediaKind ? { mediaKind: m.replyTo.mediaKind } : {}),
    };
  }
  if (m.deletedAt) frame.deletedAt = m.deletedAt;
  if (m.editedAt) frame.editedAt = m.editedAt;
  return frame;
}
