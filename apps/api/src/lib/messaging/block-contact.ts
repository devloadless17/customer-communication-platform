import type { Contact } from "@ccp/shared/types";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { recordConversationEvent } from "@/lib/inbox/events";
import { getProviderBinding } from "@/lib/providers";
import { toContactWire } from "@/lib/queries/_shared";
import { workflowContactSnapshot } from "@/lib/workflows/events";

/**
 * Block / unblock a contact at the PROVIDER (WhatsApp Block Users API).
 *
 * The provider's blocklist is the authority — we call it FIRST and only mirror
 * the outcome onto `Contact.blockedAt` when Meta accepted it, so the local
 * flag never claims a block Meta doesn't enforce. The mirror is what the send
 * internals, the broadcast runner and the reply-box lock read.
 *
 * Provider constraints surfaced as typed errors (they are operator-actionable,
 * not bugs): blocking needs an inbound within the last 24h (Meta 131047), the
 * blocklist caps at 64,000 entries (139101), and Meta rate-limits bursts
 * (130429). Unblocking has no 24h window.
 */

export class BlockContactError extends Error {
  code:
    | "contact_not_found"
    // The contact's channel has no provider-level blocklist (capability
    // `blockUsers` unset — everything except WhatsApp today).
    | "blocking_not_supported"
    | "contact_has_no_phone"
    // Meta 131047: no inbound message in the last 24h, so Meta refuses the
    // block (also returned for numbers that aren't on WhatsApp at all).
    | "reengagement_required"
    // Meta 139101: the number's 64,000-entry blocklist is full.
    | "blocklist_full"
    // Meta 130429: too many block calls in a burst — retry later.
    | "rate_limited"
    // Any other per-user provider rejection; `detail` carries Meta's message.
    | "provider_rejected";
  detail?: string;

  constructor(code: BlockContactError["code"], message: string, detail?: string) {
    super(message);
    this.name = "BlockContactError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Meta per-user error code → the typed error the API/UI can act on. */
function mapProviderFailure(failure: {
  error: { code: number | null; message: string | null; details: string | null } | null;
}): BlockContactError {
  const code = failure.error?.code ?? null;
  const detail = failure.error?.details ?? failure.error?.message ?? undefined;
  if (code === 131047) {
    return new BlockContactError(
      "reengagement_required",
      "Meta only allows blocking people who messaged you in the last 24 hours.",
      detail,
    );
  }
  if (code === 139101) {
    return new BlockContactError(
      "blocklist_full",
      "This number's blocklist is full (Meta caps it at 64,000 entries).",
      detail,
    );
  }
  if (code === 130429) {
    return new BlockContactError(
      "rate_limited",
      "Meta rate-limited the request — try again in a moment.",
      detail,
    );
  }
  return new BlockContactError(
    "provider_rejected",
    failure.error?.message ?? "The provider rejected the request.",
    detail,
  );
}

export async function setContactBlocked(args: {
  workspaceId: string;
  contactId: string;
  blocked: boolean;
  /** Acting agent; null for `/v1` (pass apiKeyId for audit attribution). */
  userId: string | null;
  apiKeyId?: string | null;
}): Promise<Contact> {
  const { workspaceId, contactId, blocked } = args;
  const row = await db.contact.findFirst({
    where: { id: contactId, workspaceId },
    include: { tags: { select: { id: true } } },
  });
  if (!row) throw new BlockContactError("contact_not_found", "contact not found");

  // The thread anchors the audit pill and names the ACCOUNT whose blocklist
  // this is (a workspace can hold several numbers; the block must land on the
  // one the person actually messages). A contact with no conversation has
  // never messaged us — Meta would refuse the block anyway (24h rule).
  const conversation = await db.conversation.findFirst({
    where: { workspaceId, contactId },
    select: { id: true, channel: true, channelConnectionId: true },
  });

  const channel = conversation?.channel ?? row.identityChannel;
  const binding = getProviderBinding(channel);
  if (
    !binding.provider.capabilities.blockUsers ||
    !binding.provider.blockUsers ||
    !binding.provider.unblockUsers
  ) {
    throw new BlockContactError(
      "blocking_not_supported",
      `blocking is not supported on ${channel}`,
    );
  }
  if (!row.phoneNumber) {
    throw new BlockContactError("contact_has_no_phone", "contact has no phone number");
  }

  // Idempotent: re-blocking a blocked contact (or unblocking an unblocked one)
  // is a no-op success, not an error — matches the provider's own semantics.
  if (blocked === (row.blockedAt !== null)) {
    return toContactWire(row, { tagIds: row.tags.map((t) => t.id) });
  }

  // Provider first, mirror second. Digits-only storage → send the `+`-prefixed
  // form (the doc's own example shape, and the same value sends use as input).
  const config = await binding.getSendConfig(
    workspaceId,
    conversation?.channelConnectionId,
  );
  const result = blocked
    ? await binding.provider.blockUsers([`+${row.phoneNumber}`], config)
    : await binding.provider.unblockUsers([`+${row.phoneNumber}`], config);
  const failure = result.failed[0];
  if (failure) throw mapProviderFailure(failure);

  const blockedAt = blocked ? new Date() : null;
  await db.contact.updateMany({
    where: { id: contactId, workspaceId },
    data: { blockedAt, version: { increment: 1 } },
  });
  const updated = { ...row, blockedAt };

  if (conversation) {
    await recordConversationEvent({
      conversationId: conversation.id,
      workspaceId,
      userId: args.userId,
      apiKeyId: args.apiKeyId ?? null,
      kind: blocked ? "contact_blocked" : "contact_unblocked",
      after: { contactId },
    });
  }

  const tagIds = row.tags.map((t) => t.id);
  const contact = toContactWire(updated, { tagIds });
  // Same catch-all every contact mutation publishes: socket fanout flips the
  // reply-box lock live for every open thread, the panel refreshes, and the
  // outbound `contact.updated` webhook carries the new `blockedAt`.
  await publish({
    type: "contact.updated",
    workspaceId,
    contact,
    previousStageId: row.stageId,
    fieldChanges: [],
    changedByUserId: args.userId,
    ...(args.apiKeyId ? { changedByApiKeyId: args.apiKeyId } : {}),
    workflowContact: workflowContactSnapshot(updated),
  });

  return contact;
}
