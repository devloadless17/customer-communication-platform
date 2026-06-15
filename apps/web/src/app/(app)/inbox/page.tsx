import { cookies, headers } from "next/headers";
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
import { SsrThreadBottomSnap } from "@/features/inbox/components/ssr-thread-bottom-snap";
import {
  INBOX_DETAILS_WIDTH_COOKIE,
  INBOX_LIST_WIDTH_COOKIE,
  parseWidthCookie,
} from "@/features/inbox/lib/panel-cookies";

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
  // Persisted drag-resize widths, SSR'd so each column paints at its saved width
  // on first render — no jump from the default after hydration (the hook clamps).
  const initialListWidth = parseWidthCookie(
    cookieStore.get(INBOX_LIST_WIDTH_COOKIE)?.value,
  );
  const initialDetailsWidth = parseWidthCookie(
    cookieStore.get(INBOX_DETAILS_WIDTH_COOKIE)?.value,
  );

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

  // The bottom-snap <script> is a PARSE-TIME hack for a real document load
  // (hard refresh / deep link): it runs as the browser parses the HTML, before
  // first paint, to land the SSR'd thread at the bottom. On a client RSC
  // navigation/refresh (`router.refresh()` after a mutation — common since
  // selection is mirrored as `?c=<id>`) there's no fresh document parse: React
  // re-renders this server component on the CLIENT, where a <script> is never
  // executed and React 19 warns ("Encountered a <script> tag while rendering").
  // The DOM already exists and useChatScroll already owns the viewport there,
  // so the snap is pointless anyway. Gate it to genuine document requests — an
  // RSC fetch carries the `RSC: 1` header; a full page load does not.
  const isRscRequest = (await headers()).get("rsc") === "1";

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
        initialListWidth={initialListWidth}
        initialDetailsWidth={initialDetailsWidth}
      />
      {/* SSR-only: when a thread was SSR'd on a real DOCUMENT load (hard refresh
          / deep link), pin its column-reverse viewport to the bottom during HTML
          parse so the first paint shows the latest message — no top-then-scroll
          jump, no visible font/layout settle at the top. Rendered AFTER the
          shell so the viewport DOM exists when the inline script runs. Skipped
          on an RSC navigation/refresh (no document parse → script wouldn't run +
          React warns). Server component; never hydrated. See the component for
          the full rationale. */}
      {initialThread && !isRscRequest ? <SsrThreadBottomSnap /> : null}
    </>
  );
}
