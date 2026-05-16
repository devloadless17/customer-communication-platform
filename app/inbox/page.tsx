import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import {
  getConversationWithRefs,
  listConversations,
  listContactFieldDefinitions,
  listContactStages,
  listSnippets,
  listTags,
  listTeamMembers,
} from "@/lib/queries";
import { canManageContactFields, canManageStages } from "@/lib/auth/permissions";
import { InboxShell } from "@/components/inbox/inbox-shell";
import type { Team, User } from "@/lib/types";

/**
 * Single-page inbox workspace.
 *
 * Reads the active conversation from `?c=<id>` so chat switching can happen
 * entirely client-side via `history.pushState` — no segment unmount, no
 * server round-trip, no loading skeleton. Direct URL hits and hard refreshes
 * still SSR the picked thread (below) so the first paint isn't blank.
 *
 * The /inbox/[conversationId] route still exists as a 301 redirect to keep
 * old links / bookmarks / external referrers working; everything inside the
 * app already routes here.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { user, teamId } = await getSession();
  const { c: requestedConversationId } = await searchParams;

  const teamRowPromise = db.team.findUniqueOrThrow({ where: { id: teamId } });
  const conversationsPromise = listConversations(teamId, { viewerUserId: user.id });
  // Single source of truth for users. The previous version ran a separate
  // raw `db.user.findMany` (active users only) AND `listTeamMembers` (all
  // users incl. deactivated) — two roundtrips returning near-identical data.
  // Now we fetch once and derive `teammates` (active, for the sidebar) from
  // the same list `teamMembers` uses (all, for historical message attribution).
  const teamMembersPromise = listTeamMembers(teamId);
  const snippetsPromise = listSnippets(teamId);
  const stagesPromise = listContactStages(teamId);
  const fieldDefinitionsPromise = listContactFieldDefinitions(teamId);
  const tagsPromise = listTags(teamId);
  // Only SSR-fetch the picked thread when the URL carried `?c=<id>`. On the
  // empty inbox state (no query param), this is null and the shell renders
  // the "pick a conversation" placeholder.
  const initialThreadPromise = requestedConversationId
    ? getConversationWithRefs(teamId, requestedConversationId)
    : Promise.resolve(null);

  const [
    teamRow,
    conversationsPage,
    teamMembers,
    snippets,
    stages,
    fieldDefinitions,
    tags,
    initialThread,
  ] = await Promise.all([
    teamRowPromise,
    conversationsPromise,
    teamMembersPromise,
    snippetsPromise,
    stagesPromise,
    fieldDefinitionsPromise,
    tagsPromise,
    initialThreadPromise,
  ]);

  // When the URL pointed at a conversation that doesn't exist (deleted, wrong
  // team, typo'd id), strip the `?c=` from the URL with a server redirect.
  // Without this, refreshing the bad URL would keep re-fetching null and the
  // address bar would lie indefinitely.
  if (requestedConversationId && !initialThread) {
    redirect("/inbox");
  }

  const team: Team = { id: teamRow.id, name: teamRow.name };
  // `teammates` (active only) drives the sidebar's online dots and presence.
  // `teamMembers` (all incl. deactivated) drives historical message
  // attribution so deactivated agents' past replies still show their name.
  const teammates: User[] = teamMembers.filter((u) => u.isActive);

  const initialActiveConversationId = initialThread ? requestedConversationId ?? null : null;

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
    />
  );
}
