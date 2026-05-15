import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import {
  countContacts,
  listAudienceGroups,
  listContactFieldDefinitions,
  listContactStages,
  listTags,
  lookupContacts,
} from "@/lib/queries";

import { NewBroadcastForm } from "./new-broadcast-form";

export const metadata = { title: "New broadcast" };
export const dynamic = "force-dynamic";

export default async function NewBroadcastPage({
  searchParams,
}: {
  // Pre-fill from the URL: `?contactIds=a,b,c` after a Contacts-page bulk
  // "Send template"; `?groupId=...` after clicking "Send broadcast" on a
  // saved group; `?tagIds=...` for tag-based deeplinks.
  searchParams: Promise<{
    contactIds?: string | string[];
    tagIds?: string | string[];
    groupId?: string | string[];
  }>;
}) {
  const { teamId } = await getSession();
  const sp = await searchParams;
  const preselectedContactIds = normalizeIds(sp.contactIds);
  const preselectedTagIds = normalizeIds(sp.tagIds);
  const preselectedGroupId =
    typeof sp.groupId === "string" && sp.groupId.trim().length > 0
      ? sp.groupId.trim()
      : null;

  // The wizard never loads the whole contact list — it works off ids and
  // resolves counts / chip labels server-side. So all we fetch here is the
  // team total, the small tag/group/field catalogs, and the labels for any
  // contacts that were deep-linked in.
  const [
    team,
    totalContactCount,
    tags,
    groups,
    fieldDefinitions,
    stages,
    contactLabels,
  ] = await Promise.all([
    db.team.findUnique({
      where: { id: teamId },
      select: { metaPhoneNumberId: true, metaWabaId: true },
    }),
    countContacts(teamId),
    listTags(teamId),
    listAudienceGroups(teamId),
    listContactFieldDefinitions(teamId),
    listContactStages(teamId),
    lookupContacts(teamId, preselectedContactIds),
  ]);

  // Pre-flight: if WhatsApp isn't even connected, bounce to the settings
  // page so the user knows what to fix.
  if (!team?.metaPhoneNumberId) {
    redirect("/settings/whatsapp?from=broadcasts");
  }

  return (
    <NewBroadcastForm
      totalContactCount={totalContactCount}
      initialContactLabels={contactLabels}
      tags={tags}
      fieldDefinitions={fieldDefinitions}
      stages={stages}
      groups={groups}
      hasWabaId={Boolean(team.metaWabaId)}
      preselectedContactIds={preselectedContactIds}
      preselectedTagIds={preselectedTagIds}
      preselectedGroupId={preselectedGroupId}
    />
  );
}

function normalizeIds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  // ?ids=a,b,c (string) OR ?ids=a&ids=b (array) — accept both.
  const arr = Array.isArray(raw) ? raw : raw.split(",");
  return Array.from(new Set(arr.map((s) => s.trim()).filter((s) => s.length > 0)));
}
