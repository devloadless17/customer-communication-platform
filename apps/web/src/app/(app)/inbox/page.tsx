import { cookies } from "next/headers";
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
import { InboxShell } from "@/features/inbox/components/inbox-shell";

/** Right contact-panel collapse cookie — read server-side so SSR renders the
 *  persisted state (no expand→collapse flash, same approach as the left
 *  AppRail). Default EXPANDED: only an explicit "true" (the user collapsed it)
 *  collapses it to a rail. Written client-side in contact-panel.tsx. */
const CONTACT_PANEL_COLLAPSED_COOKIE = "contact-panel-collapsed";

/**
 * Single-page inbox workspace.
 *
 * `?c=<id>` is read to SSR a thread so the first paint isn't blank. The shell
 * mirrors the open conversation into the URL via `history.replaceState` on
 * every chat switch (see the InboxShell header), so the steady-state URL is
 * /inbox?c=<id> and a HARD refresh re-SSRs that thread — the agent stays on the
 * conversation (scrolled to bottom via useChatScroll on mount) instead of
 * bouncing to the empty "pick a conversation" state. A SOFT refresh re-runs
 * with the same `?c=` and the shell's SSR sync no-ops, so it stays put too.
 * Entering /inbox with no `?c=` (fresh nav, post-deletion redirect) still
 * renders the empty state (`initialThread` is null).
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
    { user, permissions },
    team,
    conversationsPage,
    teamMembers,
    snippets,
    stages,
    contactFields,
    tags,
    initialThread,
    cookieStore,
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
    cookies(),
  ]);

  const contactPanelCollapsed =
    cookieStore.get(CONTACT_PANEL_COLLAPSED_COOKIE)?.value === "true";

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

  // No bottom-snap script: the thread viewport is `flex-direction: column-reverse`
  // (see message-thread.tsx), which the browser anchors at the bottom (newest)
  // on first layout — so the SSR'd thread paints at the latest message with zero
  // JS, on both a hard refresh and a client RSC navigation. The old parse-time
  // inline <script> (+ its CSP nonce + Radix querySelector) is gone.

  return (
    <>
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
        canManageStages={permissions["stages:manage"]}
        canManageContactFields={permissions["contactFields:manage"]}
        canDeleteConversations={permissions["conversations:delete"]}
        canMakeCalls={permissions["calls:make"]}
        initialActiveConversationId={initialActiveConversationId}
        initialThread={initialThread}
        initialContactPanelCollapsed={contactPanelCollapsed}
      />
    </>
  );
}
