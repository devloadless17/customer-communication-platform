import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { getSession } from "@/lib/auth/current-user";
import {
  getConversationWithRefs,
  getCurrentTeam,
  listConversations,
  listContactFieldDefinitions,
  listContactStages,
  listSnippets,
  listTags,
  listTeamMembers,
} from "@/lib/api/queries";
import { canManageContactFields, canManageStages } from "@ccp/shared/auth/permissions";
import { InboxShell } from "@/features/inbox/components/inbox-shell";
import type { User } from "@ccp/shared/types";

/**
 * Single-page inbox workspace.
 *
 * Reads the active conversation from `?c=<id>` so chat switching can happen
 * entirely client-side via `history.pushState` — no segment unmount, no
 * server round-trip, no loading skeleton. Direct URL hits and hard refreshes
 * still SSR the picked thread (below) so the first paint isn't blank.
 *
 * The /inbox/[conversationId] route still exists as a 307 redirect to keep
 * old links / bookmarks / external referrers working; everything inside the
 * app already routes here.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { user } = await getSession();
  const { c: requestedConversationId } = await searchParams;

  // Single source of truth for users. The previous version ran a separate
  // raw `db.user.findMany` (active users only) AND `listTeamMembers` (all
  // users incl. deactivated) — two roundtrips returning near-identical data.
  // Now we fetch once and derive `teammates` (active, for the sidebar) from
  // the same list `teamMembers` uses (all, for historical message attribution).
  const [
    team,
    conversationsPage,
    teamMembers,
    snippets,
    stages,
    fieldDefinitions,
    tags,
    initialThread,
  ] = await Promise.all([
    getCurrentTeam(),
    listConversations(),
    listTeamMembers(),
    listSnippets(),
    listContactStages(),
    listContactFieldDefinitions(),
    listTags(),
    // Only SSR-fetch the picked thread when the URL carried `?c=<id>`. On the
    // empty inbox state (no query param), this is null and the shell renders
    // the "pick a conversation" placeholder.
    requestedConversationId
      ? getConversationWithRefs(requestedConversationId)
      : Promise.resolve(null),
  ]);

  // When the URL pointed at a conversation that doesn't exist (deleted, wrong
  // team, typo'd id), strip the `?c=` from the URL with a server redirect.
  // Without this, refreshing the bad URL would keep re-fetching null and the
  // address bar would lie indefinitely.
  if (requestedConversationId && !initialThread) {
    redirect("/inbox");
  }

  // `teammates` (active only) drives the sidebar's online dots and presence.
  // `teamMembers` (all incl. deactivated) drives historical message
  // attribution so deactivated agents' past replies still show their name.
  const teammates: User[] = teamMembers.filter((u) => u.isActive);

  const initialActiveConversationId = initialThread ? requestedConversationId ?? null : null;

  // CSP nonce from src/proxy.ts. Threaded into InboxShell so the SSR
  // scroll-init <script> inside ThreadWorkspace executes under
  // `script-src 'nonce-...'` — without this the script is blocked and
  // hard-refresh shows a one-frame scroll flicker before useChatScroll
  // catches up.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <InboxShell
      currentUser={user}
      team={team}
      teammates={teammates}
      teamMembers={teamMembers}
      conversations={conversationsPage.items}
      nextConversationCursor={conversationsPage.nextCursor}
      snippets={snippets}
      stages={stages}
      fieldDefinitions={fieldDefinitions}
      tags={tags}
      canManageStages={canManageStages(user.role)}
      canManageContactFields={canManageContactFields(user.role)}
      initialActiveConversationId={initialActiveConversationId}
      initialThread={initialThread}
      nonce={nonce}
    />
  );
}
