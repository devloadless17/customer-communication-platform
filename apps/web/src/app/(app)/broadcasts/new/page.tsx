import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import {
  countAllContacts,
  getTeamWhatsappConfig,
  listAudienceGroups,
  listContactFieldDefinitions,
  listContactStages,
  listTags,
  lookupContacts,
} from "@/lib/api/queries";

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
  const { permissions } = await getSession();
  if (!permissions["broadcasts:manage"]) redirect("/broadcasts");

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
    config,
    totalContactCount,
    tags,
    groups,
    fieldDefinitions,
    stages,
    contactLabels,
  ] = await Promise.all([
    getTeamWhatsappConfig(),
    countAllContacts(),
    listTags(),
    listAudienceGroups(),
    listContactFieldDefinitions(),
    listContactStages(),
    lookupContacts(preselectedContactIds),
  ]);

  // Pre-flight: if WhatsApp isn't even connected, bounce to the settings
  // page so the user knows what to fix.
  if (!config.phoneNumberId) {
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
      hasWabaId={Boolean(config.wabaId)}
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
