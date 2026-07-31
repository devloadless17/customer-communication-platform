import "server-only";



import { api } from "../../api-client";
import { isApiNotFound } from "./helpers";





/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

export interface BroadcastListItem {
  id: string;
  status: string;
  name: string | null;
  /** Groups this send with its siblings — the campaign rollup's join key. */
  campaignName: string | null;
  // freeform / People (customer-mode) broadcasts carry no template — null here.
  kind: "template" | "freeform";
  channel: string;
  targetMode: "contact" | "customer";
  scheduledAt: string | null;
  templateName: string | null;
  templateLanguage: string | null;
  audienceMode: string;
  totalCount: number;
  sentCount: number;
  failedCount: number;
  createdById: string | null;
  createdByName: string;
  /** The account this campaign went out from; null when since disconnected
   *  (SetNull FK) or pre-dating account stamping. */
  channelConnectionId: string | null;
  accountName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BroadcastDetail extends BroadcastListItem {
  templateId: string | null;
  /** The template's catalog message text (null for freeform / deleted). */
  templateBody: string | null;
  bodyText: string | null;
  /** Retryable failures only (excludes cancel-finalized recipients). */
  genuineFailedCount: number;
  audienceTagIds: string[];
  audienceGroupId: string | null;
  variables: unknown;
  lastError: string | null;
  recipients: Array<{
    id: string;
    contactId: string;
    contactName: string;
    contactPhone: string | null;
    conversationId: string | null;
    status: string;
    externalId: string | null;
    errorMessage: string | null;
    sentAt: string | null;
    deliveryState: string;
    deliveredAt: string | null;
    readAt: string | null;
    repliedAt: string | null;
    clickedAt: string | null;
    clickedOptionId: string | null;
    errorCode: string | null;
  }>;
}

export async function listBroadcasts(opts?: {
  status?: string;
  search?: string;
  /** Scope to one channel, or `people` for omnichannel campaigns. */
  channel?: string;
  /** Numbered (offset) pagination — when set, the API returns `totalCount`. */
  page?: number;
  take?: number;
}): Promise<{ broadcasts: BroadcastListItem[]; totalCount?: number }> {
  const params = new URLSearchParams();
  if (opts?.status && opts.status !== "all") params.set("status", opts.status);
  if (opts?.search) params.set("search", opts.search);
  if (opts?.channel) params.set("channel", opts.channel);
  if (opts?.page != null) params.set("page", String(opts.page));
  if (opts?.take != null) params.set("take", String(opts.take));
  const qs = params.toString();
  return api<{ broadcasts: BroadcastListItem[]; totalCount?: number }>(
    `/api/broadcasts${qs ? `?${qs}` : ""}`,
  );
}

export async function getBroadcast(id: string): Promise<BroadcastDetail | null> {
  try {
    const { broadcast } = await api<{ broadcast: BroadcastDetail }>(`/api/broadcasts/${id}`);
    return broadcast;
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

/**
 * All recipient contact ids for a broadcast — used by "Duplicate" to rebuild a
 * hand-picked (`selected`/`custom`) audience that only lives on recipient rows.
 * Returns [] on a missing/foreign id so a stale `?from=` degrades gracefully.
 */
export async function getBroadcastRecipientContactIds(id: string): Promise<string[]> {
  try {
    const { contactIds } = await api<{ contactIds: string[] }>(
      `/api/broadcasts/${id}/recipient-ids`,
    );
    return contactIds;
  } catch (err) {
    if (isApiNotFound(err)) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
