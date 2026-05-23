import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import {
  getConversationWithRefs,
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
 * `?c=<id>` is read ONLY to SSR a thread on a direct ENTRY (a shared link or
 * the /inbox/[conversationId] redirect below) so the first paint isn't blank.
 * In-app chat switching is client-state only — the shell does NOT write `?c=`
 * to the URL (see the InboxShell header), so the steady-state URL is plain
 * /inbox and a HARD refresh deliberately lands on the empty "pick a
 * conversation" state (`initialThread` is null). A SOFT refresh keeps the
 * thread via preserved client state.
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
    initialThread,
  ] = await Promise.all([
    getSession(),
    getCurrentTeam(),
    listConversations(),
    listTeamMembers(),
    listSnippets(),
    listContactStages(),
    listContactFieldsWithBuiltins(),
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

  // `teamMembers` (all incl. deactivated) drives historical message
  // attribution so deactivated agents' past replies still show their name.

  const initialActiveConversationId = initialThread ? requestedConversationId ?? null : null;

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
      initialActiveConversationId={initialActiveConversationId}
      initialThread={initialThread}
    />
  );
}
