import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam } from "@/lib/api/queries/team";
import {
  listContactFieldsWithBuiltins,
  listContactStages,
  listContacts,
  listTags,
} from "@/lib/api/queries";

import { ContactsClient } from "@/features/contacts/components/contacts-client";
import type {
  ChannelFilter,
  ReachFilter,
  StageFilter,
} from "@/features/contacts/components/contact-browser";
import { isChannelLive } from "@ccp/shared/providers/capabilities";
import type { Channel } from "@ccp/shared/types";

export const metadata = {
  title: "Contacts",
};

/**
 * Server-render the first page of contacts + the team's field + tag
 * catalogs so every column can render on first paint.
 *
 * `?stage=<id|none>` seeds the stage filter — the settings page links here
 * with that query string to "show me everyone in this stage" before a
 * potential bulk-move.
 *
 * `?channel=` + `?reach=` seed the CONTACT SEGMENTS. With neither, the page
 * opens on the directory — everyone with a phone number, whatever channel they
 * came from — because that is what "a contact" means here: someone you can call.
 * A channel segment (`?channel=instagram&reach=any`) lifts that gate to show
 * everyone on that channel, phones and emails alike, which is how you reach the
 * people who will never have a phone number on file.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, permissions } = await getSession();
  const team = await getCurrentTeam();
  // The export routes deny assigned-only agents (bulk PII) — hide the button
  // rather than let it resolve to a 403 toast.
  const restrictedViewer =
    user.role === "agent" && team.agentConversationVisibility === "assigned";
  const params = await searchParams;
  const stageParam = typeof params.stage === "string" ? params.stage : undefined;
  const channelParam = typeof params.channel === "string" ? params.channel : undefined;
  const channelFilter: ChannelFilter =
    channelParam && isChannelLive(channelParam as Channel) ? (channelParam as Channel) : "any";
  // Default "phone" — the directory. A segment link passes `reach=any` to lift it.
  const reachParam = typeof params.reach === "string" ? params.reach : undefined;
  const reachFilter: ReachFilter =
    reachParam === "any" || reachParam === "email" || reachParam === "phone"
      ? reachParam
      : "phone";

  const [page, fieldsAndBuiltins, tags, stages] = await Promise.all([
    // Seed page 1 in NUMBERED (offset) mode so the SSR rows match what the
    // paginated client shows — ContactsClient runs `useContactList` in `paged`
    // mode (25/page) and trusts this seed for page 1 without an initial refetch.
    // `page`/`take` must match CONTACTS_PAGE_SIZE in contacts-client.tsx.
    listContacts({
      stageId: stageParam === "none" ? "none" : stageParam || undefined,
      ...(channelFilter !== "any" ? { channel: channelFilter } : {}),
      ...(reachFilter !== "any" ? { reach: reachFilter } : {}),
      page: 1,
      take: 25,
    }),
    listContactFieldsWithBuiltins(),
    listTags(),
    listContactStages(),
  ]);
  const { definitions: fieldDefinitions, builtins: contactPanelBuiltins } =
    fieldsAndBuiltins;

  const resolvedStageFilter: StageFilter =
    stageParam === "none"
      ? "none"
      : stageParam && stages.some((s) => s.id === stageParam)
        ? stageParam
        : "any";

  // Key by the resolved stage filter so a sidebar click (which is a soft nav
  // between two /contacts?stage=… URLs) forces ContactsClient to remount with
  // the new SSR-seeded items + stage filter. Without this, `useContactList`'s
  // useState initializers latch the first stage filter forever and the
  // sidebar appears to do nothing.
  return (
    <ContactsClient
      key={`${resolvedStageFilter}:${channelFilter}:${reachFilter}`}
      initialItems={page.items}
      initialNextCursor={page.nextCursor}
      initialTotalCount={page.totalCount ?? null}
      fieldDefinitions={fieldDefinitions}
      contactPanelBuiltins={contactPanelBuiltins}
      initialTags={tags}
      initialStages={stages}
      initialStageFilter={resolvedStageFilter}
      initialChannelFilter={channelFilter}
      initialReachFilter={reachFilter}
      canManageFields={permissions["contactFields:manage"]}
      canManageStages={permissions["stages:manage"]}
      canDeleteContacts={permissions["contacts:delete"]}
      canExportContacts={permissions["contacts:export"] && !restrictedViewer}
    />
  );
}
