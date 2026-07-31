import "server-only";

import { cache } from "react";


import { api } from "../../api-client";
import { isApiNotFound } from "./helpers";




import type {
  ConversationWithRefs,
  CursorPage,
} from "@ccp/shared/types";

/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// ---------------------------------------------------------------------------
// Conversations + messages
// ---------------------------------------------------------------------------

export interface ListConversationsOpts {
  take?: number;
  cursor?: string | null;
  search?: string;
}

// Wrapped in `React.cache` so the inbox layout (sub-sidebar count fallback)
// and the inbox page (conversation list seed) share one `/api/conversations`
// round-trip per render. React.cache keys on the arguments, so the no-arg
// calls both sides make dedupe to a single fetch; callers passing distinct
// `opts` objects are unaffected (fresh fetch, as before).
//
// Deliberately UNFILTERED: the sub-sidebar's first-paint fallback derives the
// `closed` preset count from this seed (presetCounts in inbox-sub-sidebar),
// so the SSR slice has to include closed rows for the count to be right
// before `useConversationCounts` lands. The conversation LIST consumer
// (`useTeamEvents`) prunes the seed against the active client-side filter on
// mount so closed rows don't leak into "All open".
export const listConversations = cache(async (
  opts: ListConversationsOpts = {},
): Promise<CursorPage<ConversationWithRefs>> => {
  return api<CursorPage<ConversationWithRefs>>("/api/conversations", {
    query: {
      take: opts.take,
      cursor: opts.cursor ?? undefined,
      search: opts.search ?? undefined,
    },
  });
});

export async function getConversationWithRefs(
  conversationId: string,
): Promise<{ data: ConversationWithRefs; nextOlderCursor: string | null } | null> {
  try {
    return await api<{
      data: ConversationWithRefs;
      nextOlderCursor: string | null;
    }>(`/api/inbox/conversation/${conversationId}`);
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

