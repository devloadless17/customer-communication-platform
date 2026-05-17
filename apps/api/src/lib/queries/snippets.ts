import "server-only";

import { db } from "@/lib/db";
import type { SnippetItem } from "@ccp/shared/types";

/**
 * Team-wide snippet catalog used by the reply composer's slash menu.
 *
 * Belongs at the team scope, not per-chat: snippets are usable from every
 * conversation, so fetching them per chat-switch (as ReplyBox used to do)
 * was the wrong shape. The inbox layout hydrates the catalog into a Client
 * Context at session start; this query is the source.
 *
 * Returns only what the slash menu needs — id/name/label/body. The full
 * record (createdBy, updatedAt) stays inside the settings route's own
 * fetch where it's needed for the editor list.
 */
export async function listSnippets(teamId: string): Promise<SnippetItem[]> {
  return db.snippet.findMany({
    where: { teamId },
    orderBy: [{ label: "asc" }],
    select: { id: true, name: true, label: true, body: true },
  });
}
