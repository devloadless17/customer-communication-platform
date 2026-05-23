import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import {
  getCurrentTeam,
  listConversations,
  listContactFieldsWithBuiltins,
  listContactStages,
  listSnippets,
  listTags,
  listTeamMembers,
} from "@/lib/api/queries";
import { canManageContactFields, canManageStages } from "@ccp/shared/auth/permissions";
import { InboxShell } from "@/features/inbox/components/inbox-shell";

/**
 * Single-page inbox workspace.
 *
 * Reads the active conversation from `?c=<id>` so chat switching can happen
 * entirely client-side via `history.pushState` — no segment unmount, no
 * server round-trip, no loading skeleton. A full SERVER load (hard refresh /
 * direct hit) deliberately lands on the empty "No conversation selected" state
 * (we strip `?c=` and don't SSR the thread): it keeps refresh fast — skips the
 * per-thread query — and sidesteps the SSR-paint-then-scroll-to-bottom blip.
 * The agent re-opens a thread with one click (client-side, no reload).
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
  const { c: requestedConversationId } = await searchParams;

  // Empty-on-refresh: a full server load always lands on "No conversation
  // selected". Strip `?c=` and return BEFORE the data fetch so a hard refresh
  // skips the per-thread query entirely (faster) and never SSR-paints a thread
  // that then has to scroll to the bottom. Client-side chat switching uses
  // pushState (no server hit), so this only affects refreshes / direct hits.
  if (requestedConversationId) {
    redirect("/inbox");
  }

  // Fan everything out in one Promise.all — including the session lookup —
  // so the network/DB-bound queries are not serialized behind it. Each call
  // hits its own SessionGuard on the api side anyway; the per-userId session
  // cache in the guard collapses the 8 deactivation re-checks into one.
  //
  // Single source of truth for users. The previous version ran a separate
  // raw `db.user.findMany` (active users only) AND `listTeamMembers` (all
  // users incl. deactivated) — two roundtrips returning near-identical data.
  // Now we fetch once and derive `teammates` (active, for the sidebar) from
  // the same list `teamMembers` uses (all, for historical message attribution).
  const [
    { user },
    team,
    conversationsPage,
    teamMembers,
    snippets,
    stages,
    contactFields,
    tags,
  ] = await Promise.all([
    getSession(),
    getCurrentTeam(),
    listConversations(),
    listTeamMembers(),
    listSnippets(),
    listContactStages(),
    listContactFieldsWithBuiltins(),
    listTags(),
  ]);

  // `teamMembers` (all incl. deactivated) drives historical message
  // attribution so deactivated agents' past replies still show their name.

  return (
    <InboxShell
      currentUser={user}
      team={team}
      teamMembers={teamMembers}
      conversations={conversationsPage.items}
      nextConversationCursor={conversationsPage.nextCursor}
      snippets={snippets}
      stages={stages}
      fieldDefinitions={contactFields.definitions}
      contactPanelBuiltins={contactFields.builtins}
      tags={tags}
      canManageStages={canManageStages(user.role)}
      canManageContactFields={canManageContactFields(user.role)}
      initialActiveConversationId={null}
      initialThread={null}
    />
  );
}
