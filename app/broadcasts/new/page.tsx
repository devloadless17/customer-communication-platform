import { redirect } from "next/navigation";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { listAudienceGroups, listTags } from "@/lib/queries";
import type { Contact } from "@/lib/types";

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

  // Pre-load the contact list + tags + saved groups so the wizard renders
  // fully on first paint. With the typical pilot size (low hundreds) this
  // is cheaper than two separate XHRs from the client.
  const [team, contacts, tags, groups] = await Promise.all([
    db.team.findUnique({
      where: { id: teamId },
      select: { metaPhoneNumberId: true, metaWabaId: true },
    }),
    db.contact.findMany({
      where: { teamId },
      orderBy: { name: "asc" },
      select: {
        id: true,
        teamId: true,
        phoneNumber: true,
        name: true,
        email: true,
        location: true,
        avatarUrl: true,
        customFields: true,
        source: true,
        tags: { select: { id: true } },
      },
    }),
    listTags(teamId),
    listAudienceGroups(teamId),
  ]);

  // Pre-flight: if WhatsApp isn't even connected, bounce to the settings
  // page so the user knows what to fix.
  if (!team?.metaPhoneNumberId) {
    redirect("/settings/whatsapp?from=broadcasts");
  }

  const contactsClient: Contact[] = contacts.map((c) => ({
    id: c.id,
    teamId: c.teamId,
    phoneNumber: c.phoneNumber,
    name: c.name,
    avatarUrl: c.avatarUrl ?? undefined,
    email: c.email ?? undefined,
    location: c.location ?? undefined,
    customFields: normalizeCustomFields(c.customFields),
    source: c.source as Contact["source"],
    tagIds: c.tags.map((t) => t.id),
  }));

  const sp = await searchParams;
  const preselectedContactIds = normalizeIds(sp.contactIds);
  const preselectedTagIds = normalizeIds(sp.tagIds);
  const preselectedGroupId =
    typeof sp.groupId === "string" && sp.groupId.trim().length > 0
      ? sp.groupId.trim()
      : null;

  return (
    <NewBroadcastForm
      contacts={contactsClient}
      tags={tags}
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

function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
