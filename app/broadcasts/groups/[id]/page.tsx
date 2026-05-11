import { notFound } from "next/navigation";

import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { getAudienceGroup, listTags } from "@/lib/queries";
import type { Contact } from "@/lib/types";

import { GroupForm } from "@/components/audience-groups/group-form";

export const metadata = { title: "Edit audience group" };
export const dynamic = "force-dynamic";

export default async function EditGroupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { teamId } = await getSession();
  const { id } = await params;

  const [group, contacts, tags] = await Promise.all([
    getAudienceGroup(teamId, id),
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
  ]);

  if (!group) notFound();

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

  return <GroupForm initial={group} contacts={contactsClient} tags={tags} />;
}

function normalizeCustomFields(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
